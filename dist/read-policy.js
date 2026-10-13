import fs from 'node:fs';
import path from 'node:path';
import { getArchiveDir, getConversationSourceDirs } from './paths.js';
/** Real paths of the directories the shared `read` tool may open files from. */
export function getReadableRoots() {
    const roots = new Set();
    for (const dir of [getArchiveDir(), ...getConversationSourceDirs()]) {
        try {
            roots.add(fs.realpathSync(dir));
        }
        catch { /* absent on this machine */ }
    }
    return [...roots];
}
/**
 * Where `requested` resolves on disk: the realpath of the file when it exists,
 * otherwise the realpath of its deepest existing ancestor joined with the
 * remaining (nonexistent, hence symlink-free) components. Ancestors are taken
 * from the raw string, so `..` after a symlinked directory follows the link the
 * way the filesystem would.
 */
function locate(requested) {
    try {
        return { real: fs.realpathSync(requested), exists: true };
    }
    catch { /* fall through */ }
    const rest = [];
    let current = requested;
    for (;;) {
        const parent = path.dirname(current);
        if (parent === current)
            break;
        rest.unshift(path.basename(current));
        try {
            return { real: path.join(fs.realpathSync(parent), ...rest), exists: false };
        }
        catch {
            current = parent;
        }
    }
    return { real: path.resolve(requested), exists: false };
}
const inside = (real, roots) => roots.some((root) => real === root || real.startsWith(root + path.sep));
/**
 * Validates a requested path for the shared `read` tool and returns the
 * resolved real path. Throws for anything that is not an existing .jsonl
 * file inside one of the readable roots (symlinks are resolved first).
 *
 * The root check runs before any existence or type check, so a path outside
 * the roots always gets the same error and the tool cannot be used to probe
 * whether files exist elsewhere.
 */
export function resolveReadablePath(requested, roots = getReadableRoots()) {
    if (!path.isAbsolute(requested))
        throw new Error('Path must be absolute');
    const { real, exists } = locate(requested);
    if (!inside(real, roots))
        throw new Error('Path is outside the conversation archive and transcript directories');
    if (!exists)
        throw new Error(`File not found: ${requested}`);
    if (!fs.statSync(real).isFile() || path.extname(real) !== '.jsonl')
        throw new Error('Only .jsonl conversation files can be read');
    return real;
}
