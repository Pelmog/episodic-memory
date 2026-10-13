import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createEpisodicServer, type ToolExecutor } from './mcp-factory.js';
import { createToolPool, PoolBusyError } from './tool-pool.js';

export const MAX_BODY_BYTES = 1048576;
/** Concurrent requests that contain a `tools/call` (single or in a batch). */
export const MAX_ADMITTED = 16;
/** Concurrent other requests (initialize, notifications, tools/list, ping), so sessions can connect while tools run. */
export const MAX_ADMITTED_OTHER = 64;

const isToolsCall = (message: unknown): boolean =>
  typeof message === 'object' && message !== null && (message as { method?: unknown }).method === 'tools/call';
const containsToolsCall = (body: unknown): boolean => (Array.isArray(body) ? body.some(isToolsCall) : isToolsCall(body));

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
  let activeCalls = 0;
  let activeOther = 0;
  let reading = 0;

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
    // Bounds concurrent body reads (each <= 1 MiB) before a request is classified.
    if (reading + activeCalls + activeOther >= MAX_ADMITTED + MAX_ADMITTED_OTHER) {
      res.writeHead(503, { 'Retry-After': '1' }).end();
      return;
    }
    let body: unknown;
    reading++;
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
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
    } catch {
      // The client went away mid-body.
      if (!res.headersSent) res.writeHead(400).end();
      else res.destroy();
      return;
    } finally {
      reading--;
    }
    const toolCall = containsToolsCall(body);
    if (toolCall ? activeCalls >= MAX_ADMITTED : activeOther >= MAX_ADMITTED_OTHER) {
      res.writeHead(503, { 'Retry-After': '1' }).end();
      return;
    }
    if (toolCall) activeCalls++;
    else activeOther++;
    try {
      await handle(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    } finally {
      if (toolCall) activeCalls--;
      else activeOther--;
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

const DEFAULT_PORT = 8734;
const POOL_CLOSE_BOUND_MS = 10_000;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number.`);
  return Number(raw);
}

/**
 * Validates the shared-service configuration. The bearer token is read from a
 * file (never argv or env) that must be a regular file owned by this user with
 * mode exactly 0600.
 */
export async function readHttpConfig(
  env: NodeJS.ProcessEnv,
): Promise<{ port: number; token: string; workers: number; deadlineMs: number }> {
  const tokenFile = env.EPISODIC_MEMORY_HTTP_TOKEN_FILE;
  if (!tokenFile) throw new Error('EPISODIC_MEMORY_HTTP_TOKEN_FILE is required.');
  let info;
  try {
    info = await lstat(tokenFile);
  } catch {
    throw new Error('EPISODIC_MEMORY_HTTP_TOKEN_FILE cannot be read.');
  }
  if (!info.isFile()) throw new Error('EPISODIC_MEMORY_HTTP_TOKEN_FILE must be a regular file.');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('EPISODIC_MEMORY_HTTP_TOKEN_FILE must be owned by the current user.');
  }
  if ((info.mode & 0o777) !== 0o600) throw new Error('EPISODIC_MEMORY_HTTP_TOKEN_FILE must have mode 0600.');
  // Tolerate the trailing newline editors and `echo` add; interior whitespace is rejected below.
  const token = (await readFile(tokenFile, 'utf8')).replace(/[\r\n]+$/, '');
  if (Buffer.byteLength(token) < 32 || /\s/.test(token)) {
    throw new Error('HTTP bearer token must contain at least 32 bytes without whitespace.');
  }

  const port = intFromEnv(env, 'EPISODIC_MEMORY_HTTP_PORT', DEFAULT_PORT);
  if (!((port >= 1024 && port <= 65535) || (port === 0 && process.env.VITEST))) {
    throw new Error('EPISODIC_MEMORY_HTTP_PORT must be between 1024 and 65535.');
  }
  const workers = intFromEnv(env, 'EPISODIC_MEMORY_HTTP_WORKERS', 3);
  if (workers < 1 || workers > 8) throw new Error('EPISODIC_MEMORY_HTTP_WORKERS must be between 1 and 8.');
  const deadlineMs = intFromEnv(env, 'EPISODIC_MEMORY_TOOL_DEADLINE_MS', 100_000);
  if (deadlineMs < 1000) throw new Error('EPISODIC_MEMORY_TOOL_DEADLINE_MS must be at least 1000.');
  return { port, token, workers, deadlineMs };
}

/** Waits for `pool.close()` at most `boundMs`; launchd's ExitTimeOut covers anything left. */
async function closePoolBounded(pool: { close(): Promise<void> }, boundMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), boundMs);
  });
  const outcome = await Promise.race([pool.close().then(() => 'closed' as const, () => 'closed' as const), bound]);
  clearTimeout(timer);
  if (outcome === 'timeout') process.stderr.write(`episodic-memory shutdown: worker pool did not close within ${boundMs / 1000} s\n`);
}

/**
 * Starts the shared HTTP service on 127.0.0.1. Embedding warm-up happens in the
 * workers in the background and never gates binding.
 *
 * Options (all test-only overrides): `workerPath`; `poolCloseBoundMs` (default 10 s);
 * `onWedged`, called once if the pool watchdog finds it wedged (default: exit 1 so
 * launchd's KeepAlive restarts the service).
 *
 * Test-only environment variables (read by the workers, never set in production):
 *  - EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE=1  (src/embeddings.ts)
 *  - EPISODIC_MEMORY_TEST_WARM_DELAY_MS=<ms>         (src/tool-worker.ts warm-up delay)
 */
export async function startHttp(
  options: { workerPath?: string; poolCloseBoundMs?: number; onWedged?: (reason: string) => void } = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const { port: requestedPort, token, workers, deadlineMs } = await readHttpConfig(process.env);
  const poolCloseBoundMs = options.poolCloseBoundMs ?? POOL_CLOSE_BOUND_MS;
  const pool = createToolPool({
    workerPath: options.workerPath ?? fileURLToPath(new URL('./tool-worker.js', import.meta.url)),
    size: workers,
    deadlineMs,
    maxQueue: 64,
    onWedged: options.onWedged ?? (() => process.exit(1)),
  });
  const service = createEpisodicHttpServer(token, pool.run);
  try {
    await new Promise<void>((resolve, reject) => {
      service.http.once('error', reject);
      service.http.listen(requestedPort, '127.0.0.1', () => {
        service.http.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await closePoolBounded(pool, poolCloseBoundMs);
    throw error;
  }
  const port = (service.http.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // close() rejects with ERR_SERVER_NOT_RUNNING if the server is not listening.
      if (service.http.listening) await service.close().catch(() => {});
      await closePoolBounded(pool, poolCloseBoundMs);
    })();
    return closing;
  };

  if (!process.env.VITEST) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        close().finally(() => process.exit(0));
      });
    }
  }
  process.stderr.write(`episodic-memory HTTP ready on 127.0.0.1:${port} (${workers} workers)\n`);
  return { port, close };
}
