import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initDatabase, openReadOnlyDatabase } from '../src/db.js';

describe('openReadOnlyDatabase', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-ro-'));
    delete process.env.EPISODIC_MEMORY_DB_PATH;
    process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  });

  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens a current index and refuses writes', () => {
    initDatabase().close();
    const db = openReadOnlyDatabase();
    try {
      expect(db.prepare('SELECT COUNT(*) AS c FROM exchanges').get()).toEqual({ c: 0 });
      expect(() => db.prepare('DELETE FROM exchanges').run()).toThrow(/readonly/i);
      try { db.prepare('DELETE FROM exchanges').run(); } catch (e: any) {
        expect(String(e.code)).toMatch(/SQLITE_READONLY/);
      }
    } finally {
      db.close();
    }
  });

  it('rejects an old schema with the sync hint', () => {
    const old = new Database(process.env.TEST_DB_PATH!);
    old.exec('CREATE TABLE exchanges(id TEXT)');
    old.close();
    expect(() => openReadOnlyDatabase()).toThrow(
      'The conversation index schema is older than this build; run "episodic-memory sync" first.'
    );
  });

  it('throws when the file is missing and does not create it', () => {
    expect(() => openReadOnlyDatabase()).toThrow();
    expect(fs.existsSync(process.env.TEST_DB_PATH!)).toBe(false);
  });
});
