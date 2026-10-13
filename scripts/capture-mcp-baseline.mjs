#!/usr/bin/env node
/**
 * Captures a byte-exact baseline of the MCP tool surface (tools/list plus
 * search and read outputs) by driving a built server over stdio with the
 * MCP SDK client. Run it against the pre-change (SDK v1) server to
 * (re)generate test/fixtures/mcp-baseline/*, and import runBaseline() from
 * tests to compare a server against those fixtures.
 *
 * Usage: node scripts/capture-mcp-baseline.mjs [--server dist/mcp-server.js]
 *
 * Normalisation (everything else is byte-for-byte):
 *  - the per-run temp root (and its realpath form) is replaced with <ROOT>;
 *  - exchange ids ("id": "<32 hex>"), an md5 that includes the archive path and
 *    so changes with the temp root, are replaced with "<ID>";
 *  - the server is run with TZ=UTC and LANG/LC_ALL=en_US.UTF-8 so the read
 *    tool's locale-formatted timestamps are the same on every machine.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = join(repoRoot, 'test', 'fixtures', 'mcp-baseline');
export const FIXTURE_FILES = {
  catalog: 'catalog.json',
  searchJson: 'search-text-json.txt',
  searchMarkdown: 'search-text-markdown.txt',
  read: 'read.txt',
};
const SEARCH_QUERY = 'zebra widget cache';

function isolatedEnv(root) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('EPISODIC_MEMORY_') && !k.startsWith('TEST_')) env[k] = v;
  }
  return {
    ...env,
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config'),
    TEST_DB_PATH: join(root, 'db.sqlite'),
    TEST_ARCHIVE_DIR: join(root, 'archive'),
    TEST_PROJECTS_DIR: join(root, 'projects'),
  };
}

function normaliser(root) {
  const forms = [...new Set([root, realpathSync(root)])].sort((a, b) => b.length - a.length);
  return (text) =>
    forms.reduce((t, f) => t.split(f).join('<ROOT>'), text).replace(/("id": ")[0-9a-f]{32}(")/g, '$1<ID>$2');
}

/** Runs the baseline calls against `serverPath`; returns { catalog, searchJson, searchMarkdown, read } strings. */
export async function runBaseline({
  serverPath = join(repoRoot, 'dist', 'mcp-server.js'),
  // Client/transport classes to drive the server with; defaults to the legacy v1 SDK client.
  kit = { Client, StdioClientTransport },
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'em-baseline-'));
  const env = isolatedEnv(root);
  for (const d of ['home', 'archive', 'config', 'projects/baseline-project']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'conversation.jsonl'), join(root, 'projects', 'baseline-project', 'session.jsonl'));

  const index = spawnSync(process.execPath, [join(repoRoot, 'dist', 'index-cli.js'), 'index-all', '--no-summaries'], {
    env,
    encoding: 'utf8',
  });
  if (index.status !== 0) throw new Error(`indexing failed (${index.status}): ${index.stdout}\n${index.stderr}`);

  const client = new kit.Client({ name: 'episodic-memory-baseline', version: '1.0.0' }, { capabilities: {} });
  const transport = new kit.StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'pipe', env });
  try {
    await client.connect(transport);
    const norm = normaliser(root);
    const text = (result) => {
      if (result.isError) throw new Error(`tool call failed: ${JSON.stringify(result)}`);
      return norm(result.content[0].text);
    };
    const catalog = norm(JSON.stringify({ tools: (await client.listTools()).tools }, null, 2));
    const searchJson = text(await client.callTool({ name: 'search', arguments: { query: SEARCH_QUERY, mode: 'text', response_format: 'json' } }));
    const searchMarkdown = text(await client.callTool({ name: 'search', arguments: { query: SEARCH_QUERY, mode: 'text', response_format: 'markdown' } }));
    const read = text(await client.callTool({ name: 'read', arguments: { path: join(root, 'archive', 'baseline-project', 'session.jsonl'), startLine: 1, endLine: 3 } }));
    return { catalog, searchJson, searchMarkdown, read };
  } finally {
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--server');
  const serverPath = i !== -1 ? resolve(process.argv[i + 1]) : undefined;
  const out = await runBaseline({ serverPath });
  for (const [key, file] of Object.entries(FIXTURE_FILES)) writeFileSync(join(FIXTURE_DIR, file), out[key]);
  console.log(`Wrote ${Object.values(FIXTURE_FILES).join(', ')} to ${FIXTURE_DIR}`);
}
