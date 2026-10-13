import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEpisodicHttpServer, MAX_ADMITTED, MAX_BODY_BYTES } from '../src/http.js';
import { PoolBusyError } from '../src/tool-pool.js';
import type { ToolExecutor } from '../src/mcp-factory.js';
// @ts-expect-error plain .mjs script without type declarations
import { FIXTURE_DIR, FIXTURE_FILES } from '../scripts/capture-mcp-baseline.mjs';

const token = 'test-only-not-a-real-credential-0123456789';
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

type Service = ReturnType<typeof createEpisodicHttpServer>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

const echo: ToolExecutor = async (name, args) => ({
  content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }],
});

async function serve(execute: ToolExecutor): Promise<URL> {
  const service: Service = createEpisodicHttpServer(token, execute);
  await new Promise<void>((resolve) => service.http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => service.close());
  return new URL(`http://127.0.0.1:${(service.http.address() as AddressInfo).port}/mcp`);
}

async function modernClient(url: URL): Promise<ModernClient> {
  const client = new ModernClient(
    { name: 'modern', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new ModernTransport(url, { requestInit: { headers } });
  cleanups.push(() => client.close());
  await client.connect(transport);
  expect(transport.sessionId).toBeUndefined();
  return client;
}

async function legacyClient(url: URL): Promise<LegacyClient> {
  const client = new LegacyClient({ name: 'legacy', version: '1' });
  const transport = new LegacyTransport(url, { requestInit: { headers } });
  cleanups.push(() => client.close());
  await client.connect(transport);
  expect(transport.sessionId).toBeUndefined();
  return client;
}

const pick = (t: Record<string, unknown>) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
});
const picked = (tools: unknown[]) => (tools as Array<Record<string, unknown>>).map(pick);
/** HTTP status carried by a rejected SDK call: v2 SdkHttpError.data.status, v1 StreamableHTTPError.code. */
async function statusOf(call: Promise<unknown>): Promise<number | undefined> {
  try {
    await call;
  } catch (error) {
    const e = error as { data?: { status?: number }; code?: unknown };
    return e.data?.status ?? (typeof e.code === 'number' ? e.code : undefined);
  }
  return undefined;
}
const text = (result: object): string => {
  if (!('content' in result)) throw new Error('result has no content');
  return (result.content as Array<{ text: string }>)[0].text;
};

describe('catalog and tool calls', () => {
  it('serves the baseline catalog to modern and legacy clients and runs both tools', async () => {
    const url = await serve(echo);
    const [m1, m2, l1] = [await modernClient(url), await modernClient(url), await legacyClient(url)];
    const [c1, c2, c3] = await Promise.all([m1.listTools(), m2.listTools(), l1.listTools()]);
    const baseline = JSON.parse(readFileSync(join(FIXTURE_DIR, FIXTURE_FILES.catalog), 'utf8')).tools;
    expect(c1.tools).toEqual(c2.tools);
    expect(picked(c1.tools)).toEqual(picked(baseline));
    expect(picked(c3.tools)).toEqual(picked(baseline));
    expect(c1.tools.map((t) => t.name).sort()).toEqual(['read', 'search']);

    for (const client of [m1, m2, l1]) {
      const s = await client.callTool({ name: 'search', arguments: { query: 'abc' } });
      expect(text(s)).toBe('search:{"query":"abc"}');
      const r = await client.callTool({ name: 'read', arguments: { path: '/x' } });
      expect(text(r)).toBe('read:{"path":"/x"}');
    }
  });

  it('turns a generic executor failure into an in-band error', async () => {
    const url = await serve(async () => {
      throw new Error('boom');
    });
    for (const client of [await modernClient(url), await legacyClient(url)]) {
      const result = await client.callTool({ name: 'search', arguments: { query: 'abc' } });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe('Error: boom');
    }
  });

  it('maps PoolBusyError to HTTP 503 with Retry-After', async () => {
    const url = await serve(async () => {
      throw new PoolBusyError();
    });
    const rpc = () =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'abc' } },
        }),
      });
    const res = await rpc();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');

    const modern = await modernClient(url);
    expect(await statusOf(modern.callTool({ name: 'search', arguments: { query: 'abc' } }))).toBe(503);
    const legacy = await legacyClient(url);
    expect(await statusOf(legacy.callTool({ name: 'search', arguments: { query: 'abc' } }))).toBe(503);
    // the server is still healthy afterwards
    expect((await modern.listTools()).tools).toHaveLength(2);
  });
});

describe('late PoolBusyError', () => {
  it('maps PoolBusyError raised after a macrotask to 503 for modern and legacy clients', async () => {
    const url = await serve(async () => {
      await new Promise((resolve) => setTimeout(resolve));
      throw new PoolBusyError();
    });
    const modern = await modernClient(url);
    expect(await statusOf(modern.callTool({ name: 'search', arguments: { query: 'abc' } }))).toBe(503);
    const legacy = await legacyClient(url);
    expect(await statusOf(legacy.callTool({ name: 'search', arguments: { query: 'abc' } }))).toBe(503);
  });
});

describe('request gatekeeping', () => {
  it('rejects bad auth, host, origin, method, path, body', async () => {
    const url = await serve(echo);
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect(
      (await fetch(url, { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong' }, body: '{}' })).status,
    ).toBe(401);
    expect(
      (await fetch(url, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${'x'.repeat(token.length)}` }, body: '{}' })).status,
    ).toBe(401);
    const origin = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://attacker.example' },
      body: '{}',
    });
    expect(origin.status).toBe(403);
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, Host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(hostStatus).toBe(403);
    expect((await fetch(new URL('/other', url), { method: 'POST', headers, body: '{}' })).status).toBe(404);
    const get = await fetch(url, { headers });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await fetch(url, { method: 'POST', headers, body: '{broken' })).status).toBe(400);
    expect(
      (await fetch(url, { method: 'POST', headers, body: 'x'.repeat(MAX_BODY_BYTES + 1) })).status,
    ).toBe(413);
  });

  it('validates the token at construction', () => {
    expect(() => createEpisodicHttpServer('short', echo)).toThrow(/32 bytes/);
    expect(() => createEpisodicHttpServer(`${'a'.repeat(20)} ${'b'.repeat(20)}`, echo)).toThrow(/whitespace/);
  });
});

describe('admission', () => {
  it('admits 16 concurrent calls, answers the 17th with 503, then recovers', async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const url = await serve(async () => {
      entered++;
      await gate;
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    expect(MAX_ADMITTED).toBe(16);
    const clients = await Promise.all(Array.from({ length: MAX_ADMITTED + 1 }, () => modernClient(url)));
    const call = (c: ModernClient) => c.callTool({ name: 'search', arguments: { query: 'abc' } });
    let pending: Array<ReturnType<typeof call>> = [];
    try {
      pending = clients.slice(0, MAX_ADMITTED).map(call);
      const deadline = Date.now() + 2000;
      while (entered < MAX_ADMITTED && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(entered).toBe(MAX_ADMITTED);
      expect(await statusOf(call(clients[MAX_ADMITTED]))).toBe(503);
    } finally {
      release();
    }
    const results = await Promise.all(pending);
    for (const r of results) expect(text(r)).toBe('ok');
    expect(text(await call(clients[MAX_ADMITTED]))).toBe('ok');
  });
});
