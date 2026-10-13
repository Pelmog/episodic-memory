// Read-only probe of the shared episodic-memory HTTP service.
// Prints only counts, latencies and ok/fail. Never prints the token or transcript text.
import fs from 'node:fs/promises';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = (await fs.readFile(process.env.EPISODIC_MEMORY_HTTP_TOKEN_FILE, 'utf8')).trim();
const port = process.env.EPISODIC_MEMORY_HTTP_PORT ?? '8734';
const url = new URL(process.env.EPISODIC_MEMORY_HTTP_URL ?? `http://127.0.0.1:${port}/mcp`);
const baselineUrl = new URL('../test/fixtures/mcp-baseline/catalog.json', import.meta.url);
const headers = { Authorization: `Bearer ${token}` };

const pick = (t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });
const baseline = JSON.parse(await fs.readFile(baselineUrl, 'utf8')).tools.map(pick);
const timed = async (fn) => { const t = Date.now(); const value = await fn(); return [value, Date.now() - t]; };

async function exercise(label, client, transport) {
  if (transport.sessionId) throw new Error(`${label}: unexpected session id`);
  const [list, listMs] = await timed(() => client.listTools());
  if (JSON.stringify(list.tools.map(pick)) !== JSON.stringify(baseline)) throw new Error(`${label}: tools/list differs from baseline`);
  const [search, searchMs] = await timed(() => client.callTool({
    name: 'search', arguments: { query: process.env.EPISODIC_MEMORY_PROBE_QUERY ?? 'episodic memory', mode: 'text', limit: 3, response_format: 'json' },
  }));
  if (search.isError) throw new Error(`${label}: search returned an error`);
  const results = JSON.parse(search.content[0].text).results ?? [];
  let readMs = null;
  let readOk = null;
  if (results.length > 0) {
    const [read, ms] = await timed(() => client.callTool({
      name: 'read', arguments: { path: results[0].exchange.archivePath, startLine: 1, endLine: 5 },
    }));
    if (read.isError) throw new Error(`${label}: read returned an error`);
    readMs = ms;
    readOk = true;
  }
  return { client: label, tools: list.tools.length, listMs, searchResults: results.length, searchMs, readOk, readMs };
}

const clients = [];
try {
  const modern = new ModernClient({ name: 'em-probe-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const modernTransport = new ModernTransport(url, { requestInit: { headers } });
  clients.push(modern);
  await modern.connect(modernTransport);
  const legacy = new LegacyClient({ name: 'em-probe-legacy', version: '1' });
  const legacyTransport = new LegacyTransport(url, { requestInit: { headers } });
  clients.push(legacy);
  await legacy.connect(legacyTransport);
  const report = [await exercise('modern', modern, modernTransport), await exercise('legacy', legacy, legacyTransport)];
  console.log(JSON.stringify({ ok: true, catalogMatchesBaseline: true, clients: report }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, reason: String(error?.message ?? error).slice(0, 200) }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
}
