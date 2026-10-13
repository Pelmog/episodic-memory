import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_KEYS = ['TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR', 'EPISODIC_MEMORY_CONFIG_DIR', 'CODEX_HOME', 'EPISODIC_MEMORY_DB_PATH'];
const saved: Record<string, string | undefined> = {};
let root: string;

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'em-policy-')));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-10-13T00:00:00Z' }) + '\n';

describe('resolveReadablePath', () => {
  let archive: string, outside: string, evil: string, good: string;
  beforeAll(() => {
    archive = join(root, 'archive');
    evil = join(root, 'archive-evil');
    outside = join(root, 'outside');
    for (const d of [archive, evil, outside]) mkdirSync(d, { recursive: true });
    good = join(archive, 'c.jsonl');
    writeFileSync(good, line);
    writeFileSync(join(evil, 'c.jsonl'), line);
    writeFileSync(join(outside, 'secret.jsonl'), line);
    writeFileSync(join(archive, 'notes.txt'), 'x');
    symlinkSync(join(outside, 'secret.jsonl'), join(archive, 'link.jsonl'));
  });

  it('allows a .jsonl inside a root and returns its realpath', async () => {
    const { resolveReadablePath } = await import('../src/read-policy.js');
    expect(resolveReadablePath(good, [archive])).toBe(good);
  });
  it('rejects relative paths', async () => {
    const { resolveReadablePath } = await import('../src/read-policy.js');
    expect(() => resolveReadablePath('archive/c.jsonl', [archive])).toThrow('Path must be absolute');
  });
  it('rejects missing files', async () => {
    const { resolveReadablePath } = await import('../src/read-policy.js');
    const p = join(archive, 'nope.jsonl');
    expect(() => resolveReadablePath(p, [archive])).toThrow(`File not found: ${p}`);
  });
  it('rejects non-jsonl files and directories', async () => {
    const { resolveReadablePath } = await import('../src/read-policy.js');
    expect(() => resolveReadablePath(join(archive, 'notes.txt'), [archive])).toThrow('Only .jsonl conversation files can be read');
    expect(() => resolveReadablePath(archive, [archive])).toThrow('Only .jsonl conversation files can be read');
  });
  it('rejects .. traversal, sibling-prefix dirs and symlinks out of the root', async () => {
    const { resolveReadablePath } = await import('../src/read-policy.js');
    const msg = 'Path is outside the conversation archive and transcript directories';
    expect(() => resolveReadablePath(join(archive, '..', 'outside', 'secret.jsonl'), [archive])).toThrow(msg);
    expect(() => resolveReadablePath(join(evil, 'c.jsonl'), [archive])).toThrow(msg);
    expect(() => resolveReadablePath(join(archive, 'link.jsonl'), [archive])).toThrow(msg);
  });
  it('gives the same "outside" message whether or not an outside path exists (no existence oracle)', async () => {
    const { resolveReadablePath } = await import('../src/read-policy.js');
    const msg = 'Path is outside the conversation archive and transcript directories';
    for (const p of [
      join(outside, 'nope.jsonl'),
      join(outside, 'secret.jsonl'),
      join(outside, 'nope.txt'),
      join(root, 'no-such-dir', 'x.jsonl'),
      join(archive, '..', 'outside', 'missing.jsonl'),
      join(archive, 'no-such-sub', '..', '..', 'outside', 'secret.jsonl'),
      '/definitely/not/here.jsonl',
    ]) {
      expect(() => resolveReadablePath(p, [archive]), p).toThrow(msg);
    }
  });
});

describe('getReadableRoots', () => {
  it('contains realpaths of existing archive, projects and codex dirs and omits absent ones', async () => {
    const { getReadableRoots } = await import('../src/read-policy.js');
    const a = join(root, 'd-archive');
    const p = join(root, 'd-projects');
    const codex = join(root, 'd-codex');
    for (const d of [a, p, join(codex, 'sessions')]) mkdirSync(d, { recursive: true });
    delete process.env.EPISODIC_MEMORY_DB_PATH;
    process.env.TEST_ARCHIVE_DIR = a;
    process.env.TEST_PROJECTS_DIR = p;
    expect(getReadableRoots()).toEqual(expect.arrayContaining([realpathSync(a), realpathSync(p)]));

    delete process.env.TEST_PROJECTS_DIR;
    process.env.CODEX_HOME = codex;
    const roots = getReadableRoots();
    expect(roots).toContain(realpathSync(join(codex, 'sessions')));
    expect(roots).toContain(realpathSync(a));

    process.env.CODEX_HOME = join(root, 'no-such-codex');
    expect(getReadableRoots().some((r) => r.startsWith(join(root, 'no-such-codex') + sep))).toBe(false);
  });
});

describe('search -> read roundtrip', () => {
  it('every archivePath returned by search is readable under the policy', async () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'em-roundtrip-')));
    try {
      for (const d of ['home', 'archive', 'config', 'projects/baseline-project']) mkdirSync(join(r, d), { recursive: true });
      copyFileSync(join(repo, 'test/fixtures/mcp-baseline/conversation.jsonl'), join(r, 'projects/baseline-project/session.jsonl'));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith('EPISODIC_MEMORY_') && !k.startsWith('TEST_')) env[k] = v;
      }
      Object.assign(env, {
        HOME: join(r, 'home'), EPISODIC_MEMORY_CONFIG_DIR: join(r, 'config'), TEST_DB_PATH: join(r, 'db.sqlite'),
        TEST_ARCHIVE_DIR: join(r, 'archive'), TEST_PROJECTS_DIR: join(r, 'projects'),
      });
      const idx = spawnSync(process.execPath, [join(repo, 'dist/index-cli.js'), 'index-all', '--no-summaries'], { env, encoding: 'utf8' });
      expect(idx.status, idx.stderr).toBe(0);

      delete process.env.EPISODIC_MEMORY_DB_PATH;
      Object.assign(process.env, { EPISODIC_MEMORY_CONFIG_DIR: env.EPISODIC_MEMORY_CONFIG_DIR, TEST_DB_PATH: env.TEST_DB_PATH, TEST_ARCHIVE_DIR: env.TEST_ARCHIVE_DIR, TEST_PROJECTS_DIR: env.TEST_PROJECTS_DIR });
      const { callTool } = await import('../src/mcp-tools.js');
      const { resolveReadablePath } = await import('../src/read-policy.js');
      const search = await callTool('search', { query: 'zebra widget cache', mode: 'text', response_format: 'json' });
      expect(search.isError).toBeFalsy();
      const parsed = JSON.parse(search.content[0].text);
      const paths: string[] = (parsed.results ?? parsed).map((x: any) => x.exchange.archivePath);
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        const res = await callTool('read', { path: p }, { resolveReadPath: (q) => resolveReadablePath(q) });
        expect(res.isError, `${p}: ${JSON.stringify(res)}`).toBeFalsy();
      }
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  }, 120000);
});

describe('audit-archive-paths script', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));

  /** Builds a minimal index whose exchanges.archive_path values are `paths`, then runs the audit. */
  function audit(r: string, paths: string[]) {
    const dbFile = join(r, 'db.sqlite');
    const setup = spawnSync(process.execPath, ['-e', `
      const D = require('better-sqlite3'); const d = new D(${JSON.stringify(dbFile)});
      d.exec('CREATE TABLE exchanges(id INTEGER PRIMARY KEY, archive_path TEXT)');
      const i = d.prepare('INSERT INTO exchanges(archive_path) VALUES (?)');
      for (const p of ${JSON.stringify(paths)}) i.run(p);`], { cwd: repo, encoding: 'utf8' });
    expect(setup.status, setup.stderr).toBe(0);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('EPISODIC_MEMORY_') && !k.startsWith('TEST_')) env[k] = v;
    }
    Object.assign(env, { EPISODIC_MEMORY_CONFIG_DIR: join(r, 'config'), TEST_DB_PATH: dbFile, TEST_ARCHIVE_DIR: join(r, 'archive'), TEST_PROJECTS_DIR: join(r, 'archive') });
    return spawnSync(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), 'scripts/audit-archive-paths.mjs'], { cwd: repo, env, encoding: 'utf8' });
  }

  function tempRoot(): string {
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'em-audit-')));
    for (const d of ['archive/proj', 'outside', 'config']) mkdirSync(join(r, d), { recursive: true });
    writeFileSync(join(r, 'archive/proj/a.jsonl'), line);
    writeFileSync(join(r, 'outside/b.jsonl'), line);
    return r;
  }

  it('exits 1 with correct counts when a stored path is outside the roots', () => {
    const r = tempRoot();
    try {
      const out = audit(r, [join(r, 'archive/proj/a.jsonl'), join(r, 'outside/b.jsonl')]);
      expect(out.status, out.stderr).toBe(1);
      expect(out.stdout).toContain('distinct archive paths: 2');
      expect(out.stdout).toContain('not readable under policy: 1');
      expect(out.stdout).toContain('outside roots: 1');
      expect(out.stdout).toContain(join(r, 'outside'));
      expect(out.stdout).not.toContain('a.jsonl');
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  }, 60000);

  it('reports missing files separately and exits 0 when nothing is outside the roots', () => {
    const r = tempRoot();
    try {
      const out = audit(r, [join(r, 'archive/proj/a.jsonl'), join(r, 'archive/proj/gone.jsonl')]);
      expect(out.status, out.stdout + out.stderr).toBe(0);
      expect(out.stdout).toContain('outside roots: 0');
      expect(out.stdout).toContain('missing files: 1');
      expect(out.stdout).not.toContain('gone.jsonl');
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  }, 60000);
});
