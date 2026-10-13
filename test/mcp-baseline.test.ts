import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs script without type declarations
import { runBaseline, FIXTURE_DIR, FIXTURE_FILES } from '../scripts/capture-mcp-baseline.mjs';

const serverPath = fileURLToPath(new URL('../dist/mcp-server.js', import.meta.url));
const fixture = (file: string) => readFileSync(join(FIXTURE_DIR, file), 'utf8');

describe('MCP tool surface baseline (SDK v1, stdio)', () => {
  it('reproduces the captured fixtures byte-for-byte', async () => {
    const out = await runBaseline({ serverPath });
    expect(out.catalog).toBe(fixture(FIXTURE_FILES.catalog));
    expect(out.searchJson).toBe(fixture(FIXTURE_FILES.searchJson));
    expect(out.searchMarkdown).toBe(fixture(FIXTURE_FILES.searchMarkdown));
    expect(out.read).toBe(fixture(FIXTURE_FILES.read));
  }, 120000);
});
