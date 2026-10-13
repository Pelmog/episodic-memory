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
export declare function startHttp(): Promise<void>;
