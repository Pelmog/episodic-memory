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

describe('disposeEmbeddings', () => {
  beforeEach(() => {
    vi.resetModules();
    pipelineSpy.mockReset();
  });

  it('refuses any new load once disposal has begun', async () => {
    const { initEmbeddings, disposeEmbeddings, EmbeddingsUnavailableError } = await import('../src/embeddings.js');
    await disposeEmbeddings();
    await expect(initEmbeddings()).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('waits for an in-flight load, disposes its pipeline, and never starts another', async () => {
    const dispose = vi.fn(async () => {});
    pipelineSpy.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(Object.assign(async () => ({ data: new Float32Array(384) }), { dispose })), 50))
    );
    const { initEmbeddings, disposeEmbeddings, generateQueryEmbedding, EmbeddingsUnavailableError } = await import('../src/embeddings.js');
    const loading = initEmbeddings();
    const disposing = disposeEmbeddings();
    await expect(initEmbeddings()).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    await loading;
    await disposing;
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(generateQueryEmbedding('x')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
  });
});

describe('remote model downloads', () => {
  beforeEach(() => {
    vi.resetModules();
    pipelineSpy.mockReset();
    pipelineSpy.mockImplementation(async () => async () => ({ data: new Float32Array(384) }));
  });

  it('are left at the library default unless the worker disables them', async () => {
    const transformers = await import('@huggingface/transformers');
    const env: { allowRemoteModels?: boolean } = transformers.env;
    delete env.allowRemoteModels;
    const { initEmbeddings } = await import('../src/embeddings.js');
    await initEmbeddings();
    expect(env.allowRemoteModels).toBeUndefined();
  });

  it('are disabled when shared mode asks for offline-only loading', async () => {
    const transformers = await import('@huggingface/transformers');
    const env: { allowRemoteModels?: boolean } = transformers.env;
    delete env.allowRemoteModels;
    const { initEmbeddings, configureEmbeddings } = await import('../src/embeddings.js');
    configureEmbeddings({ allowRemoteModels: false });
    await initEmbeddings();
    expect(env.allowRemoteModels).toBe(false);
  });
});
