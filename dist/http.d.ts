import { type Server as HttpServer } from 'node:http';
import { type ToolExecutor } from './mcp-factory.js';
export declare const MAX_BODY_BYTES = 1048576;
export declare const MAX_ADMITTED = 16;
/**
 * Authenticated, stateless MCP-over-HTTP boundary in front of a tool executor
 * (normally the shared worker pool).
 */
export declare function createEpisodicHttpServer(token: string, execute: ToolExecutor): {
    http: HttpServer;
    close(): Promise<void>;
};
/**
 * Validates the shared-service configuration. The bearer token is read from a
 * file (never argv or env) that must be a regular file owned by this user with
 * mode exactly 0600.
 */
export declare function readHttpConfig(env: NodeJS.ProcessEnv): Promise<{
    port: number;
    token: string;
    workers: number;
    deadlineMs: number;
}>;
/**
 * Starts the shared HTTP service on 127.0.0.1. Embedding warm-up happens in the
 * workers in the background and never gates binding.
 *
 * Test-only environment variables (read by the workers, never set in production):
 *  - EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE=1  (src/embeddings.ts)
 *  - EPISODIC_MEMORY_TEST_WARM_DELAY_MS=<ms>         (src/tool-worker.ts warm-up delay)
 */
export declare function startHttp(options?: {
    workerPath?: string;
}): Promise<{
    port: number;
    close(): Promise<void>;
}>;
