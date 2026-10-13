import { describe, it, expect, vi, beforeEach } from 'vitest';

const pipelineSpy = vi.fn();
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: (...args: unknown[]) => pipelineSpy(...args),
}));

describe('initEmbeddings singleflight', () => {
  beforeEach(() => {
    vi.resetModules();
    pipelineSpy.mockReset();
  });

  it('shares one in-flight load across concurrent callers', async () => {
    pipelineSpy.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(async () => ({ data: new Float32Array(384) })), 50))
    );
    const { initEmbeddings } = await import('../src/embeddings.js');
    await Promise.all([initEmbeddings(), initEmbeddings(), initEmbeddings()]);
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
    await initEmbeddings();
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
  });

  it('clears a failed load so a later call retries', async () => {
    pipelineSpy
      .mockImplementationOnce(() => Promise.reject(new Error('load failed')))
      .mockImplementationOnce(async () => async () => ({ data: new Float32Array(384) }));
    const { initEmbeddings } = await import('../src/embeddings.js');
    await expect(initEmbeddings()).rejects.toThrow('load failed');
    await initEmbeddings();
    expect(pipelineSpy).toHaveBeenCalledTimes(2);
  });
});
