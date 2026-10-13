import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
beforeAll(() => {
  delete process.env.EPISODIC_MEMORY_DB_PATH;
  root = mkdtempSync(join(tmpdir(), 'em-tools-'));
  for (const d of ['archive', 'projects', 'config']) mkdirSync(join(root, d), { recursive: true });
  Object.assign(process.env, { TEST_DB_PATH: join(root, 'db.sqlite'), TEST_ARCHIVE_DIR: join(root, 'archive'), TEST_PROJECTS_DIR: join(root, 'projects'), EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config') });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('mcp-tools', () => {
  it('matches the baseline catalog byte-for-byte', async () => {
    const { TOOL_DEFINITIONS } = await import('../src/mcp-tools.js');
    const baseline = JSON.parse(readFileSync('test/fixtures/mcp-baseline/catalog.json', 'utf8'));
    expect(JSON.stringify({ tools: TOOL_DEFINITIONS }, null, 2)).toBe(JSON.stringify(baseline, null, 2));
  });
  it('returns errors in-band', async () => {
    const { callTool } = await import('../src/mcp-tools.js');
    expect(await callTool('nope', {})).toEqual({ isError: true, content: [{ type: 'text', text: 'Error: Unknown tool: nope' }] });
    expect((await callTool('search', { query: 'x' })).isError).toBe(true);
  });
  it('read uses resolveReadPath and reports its refusal', async () => {
    const { callTool } = await import('../src/mcp-tools.js');
    const file = join(root, 'archive', 'c.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-10-13T00:00:00Z' }) + '\n');
    const seen: string[] = [];
    expect((await callTool('read', { path: '/x.jsonl' }, { resolveReadPath: (p) => { seen.push(p); return file; } })).isError).toBeFalsy();
    expect(seen).toEqual(['/x.jsonl']);
    expect(await callTool('read', { path: file }, { resolveReadPath: () => { throw new Error('Path is outside the conversation archive and transcript directories'); } }))
      .toEqual({ isError: true, content: [{ type: 'text', text: 'Error: Path is outside the conversation archive and transcript directories' }] });
  });
  it('honours an aborted signal', async () => {
    const { callTool } = await import('../src/mcp-tools.js');
    const c = new AbortController(); c.abort(new Error('cancelled'));
    expect((await callTool('search', { query: 'hello' }, { signal: c.signal })).isError).toBe(true);
  });
});
