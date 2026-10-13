import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createEpisodicServer, type ToolExecutor } from './mcp-factory.js';
import { PoolBusyError } from './tool-pool.js';

export const MAX_BODY_BYTES = 1048576;
export const MAX_ADMITTED = 16;

type RequestState = { busy: boolean };

/**
 * Authenticated, stateless MCP-over-HTTP boundary in front of a tool executor
 * (normally the shared worker pool).
 */
export function createEpisodicHttpServer(
  token: string,
  execute: ToolExecutor,
): { http: HttpServer; close(): Promise<void> } {
  if (Buffer.byteLength(token) < 32 || /\s/.test(token)) {
    throw new Error('HTTP bearer token must contain at least 32 bytes without whitespace.');
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const state = new AsyncLocalStorage<RequestState>();

  // PoolBusyError must become HTTP 503, which only the HTTP layer can emit; any
  // other executor failure stays an in-band tool error.
  const guarded: ToolExecutor = async (name, args, signal) => {
    try {
      return await execute(name, args, signal);
    } catch (error) {
      if (error instanceof PoolBusyError) {
        const current = state.getStore();
        if (current) current.busy = true;
        return { content: [{ type: 'text', text: 'Error: server busy' }], isError: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  };

  // Legacy (2025-era) clients are served by our own stateless leg with
  // enableJsonResponse, so the HTTP response is produced only after the tool
  // settles. (The SDK's built-in stateless fallback answers with an SSE stream
  // before the handler runs, which would make a late PoolBusyError unmappable.)
  const legacyFetch = async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
    if (request.method.toUpperCase() !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    const server = createEpisodicServer({ execute: guarded });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    const teardown = () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    };
    request.signal?.addEventListener('abort', teardown, { once: true });
    try {
      await server.connect(transport);
      const handled = transport.handleRequest(request, {
        ...(options?.parsedBody !== undefined && { parsedBody: options.parsedBody }),
      });
      handled.catch(() => {}); // a late rejection after an abort must not go unhandled
      // On client disconnect the JSON-mode exchange never settles; race it so
      // the admission slot is always released.
      const aborted = new Promise<Response>((resolve) => {
        if (request.signal.aborted) resolve(new Response(null, { status: 499 }));
        else request.signal.addEventListener('abort', () => resolve(new Response(null, { status: 499 })), { once: true });
      });
      return await Promise.race([handled, aborted]);
    } catch {
      process.stderr.write('episodic-memory legacy request failed\n');
      return new Response(null, { status: 500 });
    } finally {
      teardown();
    }
  };

  const mcp: McpHttpHandler = createMcpHandler(() => createEpisodicServer({ execute: guarded }), {
    legacy: 'reject',
    maxSubscriptions: 0,
    onerror: () => process.stderr.write('episodic-memory rejected a protocol request\n'),
  });
  const handle = toNodeHandler({
    fetch: async (request, options) => {
      const store: RequestState = { busy: false };
      const response = await state.run(store, async () =>
        (await isLegacyRequest(request.clone(), options?.parsedBody))
          ? legacyFetch(request, options)
          : mcp.fetch(request, options));
      return store.busy
        ? new Response(null, { status: 503, headers: { 'Retry-After': '1' } })
        : response;
    },
  });
  const validHost = localhostHostValidation();
  const validOrigin = localhostOriginValidation();
  let active = 0;

  const http = createServer(async (req, res) => {
    if (!validHost(req, res) || !validOrigin(req, res)) return;
    const presented = Buffer.from(req.headers.authorization ?? '');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="episodic-memory"' }).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (active >= MAX_ADMITTED) {
      res.writeHead(503, { 'Retry-After': '1' }).end();
      return;
    }
    active++;
    try {
      // Bound memory before the SDK adapter buffers/parses the body.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      await handle(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    } finally {
      active--;
    }
  });
  // Request receipt only; tool execution is bounded by the pool deadline.
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;

  return {
    http,
    close: async () => {
      await mcp.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

export async function startHttp(): Promise<void> {
  throw new Error('HTTP mode not built yet');
}
