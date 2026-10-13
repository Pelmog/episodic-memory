/** Real paths of the directories the shared `read` tool may open files from. */
export declare function getReadableRoots(): string[];
/**
 * Validates a requested path for the shared `read` tool and returns the
 * resolved real path. Throws for anything that is not an existing .jsonl
 * file inside one of the readable roots (symlinks are resolved first).
 */
export declare function resolveReadablePath(requested: string, roots?: string[]): string;
