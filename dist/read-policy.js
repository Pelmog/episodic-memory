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
 * Validates a requested path for the shared `read` tool and returns the
 * resolved real path. Throws for anything that is not an existing .jsonl
 * file inside one of the readable roots (symlinks are resolved first).
 */
export function resolveReadablePath(requested, roots = getReadableRoots()) {
    if (!path.isAbsolute(requested))
        throw new Error('Path must be absolute');
    let real;
    try {
        real = fs.realpathSync(requested);
    }
    catch {
        throw new Error(`File not found: ${requested}`);
    }
    if (!fs.statSync(real).isFile() || path.extname(real) !== '.jsonl')
        throw new Error('Only .jsonl conversation files can be read');
    if (!roots.some((root) => real.startsWith(root + path.sep)))
        throw new Error('Path is outside the conversation archive and transcript directories');
    return real;
}
