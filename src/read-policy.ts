import fs from 'node:fs';
import path from 'node:path';
import { getArchiveDir, getConversationSourceDirs } from './paths.js';

/** Real paths of the directories the shared `read` tool may open files from. */
export function getReadableRoots(): string[] {
  const roots = new Set<string>();
  for (const dir of [getArchiveDir(), ...getConversationSourceDirs()]) {
    try { roots.add(fs.realpathSync(dir)); } catch { /* absent on this machine */ }
  }
  return [...roots];
}

/**
 * Where `requested` resolves on disk: the realpath of the file when it exists,
 * otherwise the realpath of the longest existing prefix of the raw string
 * (found by stripping trailing components with path.dirname, which does not
 * normalise) joined with the remaining components. Any `..` inside that
 * existing prefix is resolved by realpath after symlinks, as the filesystem
 * would. A `..` in the nonexistent remainder is resolved lexically by
 * path.join; it can only cancel a nonexistent component (not a symlink) or a
 * component of the already-resolved real prefix, so the lexical result is the
 * physical one. (The filesystem could not open such a path anyway; the result
 * only decides which error is reported.)
 */
function locate(requested: string): { real: string; exists: boolean } {
  try { return { real: fs.realpathSync(requested), exists: true }; } catch { /* fall through */ }
  const rest: string[] = [];
  let current = requested;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    try { return { real: path.join(fs.realpathSync(parent), ...rest), exists: false }; } catch { current = parent; }
  }
  return { real: path.resolve(requested), exists: false };
}

const inside = (real: string, roots: string[]) => roots.some((root) => real === root || real.startsWith(root + path.sep));

/**
 * Validates a requested path for the shared `read` tool and returns the
 * resolved real path. Throws for anything that is not an existing .jsonl
 * file inside one of the readable roots (symlinks are resolved first).
 *
 * The root check runs before any existence or type check, so a path outside
 * the roots always gets the same error and the tool cannot be used to probe
 * whether files exist elsewhere.
 */
export function resolveReadablePath(requested: string, roots: string[] = getReadableRoots()): string {
  if (!path.isAbsolute(requested)) throw new Error('Path must be absolute');
  const { real, exists } = locate(requested);
  if (!inside(real, roots)) throw new Error('Path is outside the conversation archive and transcript directories');
  if (!exists) throw new Error(`File not found: ${requested}`);
  if (!fs.statSync(real).isFile() || path.extname(real) !== '.jsonl') throw new Error('Only .jsonl conversation files can be read');
  return real;
}
