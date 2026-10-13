import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => { throw new Error('boom'); }),
  generateQueryEmbedding: vi.fn(),
}));

import { initDatabase } from '../src/db.js';
import { searchConversations, configureSearchDatabase } from '../src/search.js';

describe('search closes its DB handle on failure', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-lifecycle-'));
    delete process.env.EPISODIC_MEMORY_DB_PATH;
    process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  });

  afterEach(() => {
    configureSearchDatabase(initDatabase);
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('closes when the vector path throws', async () => {
    const real = initDatabase();
    const close = vi.fn(() => real.close());
    const fake = new Proxy(real, {
      get: (t, p) => (p === 'close' ? close : (t as any)[p]?.bind?.(t) ?? (t as any)[p]),
    });
    configureSearchDatabase(() => fake as any);
    await expect(searchConversations('hello', { mode: 'vector' })).rejects.toThrow('boom');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes when the text path throws', async () => {
    const real = initDatabase();
    const close = vi.fn(() => real.close());
    const fake = {
      prepare: () => { throw new Error('prepare failed'); },
      close,
    };
    configureSearchDatabase(() => fake as any);
    await expect(searchConversations('hello', { mode: 'text' })).rejects.toThrow('prepare failed');
    expect(close).toHaveBeenCalledTimes(1);
    real.close();
  });
});
