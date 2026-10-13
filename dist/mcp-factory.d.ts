import { Server } from '@modelcontextprotocol/server';
import { type ToolResult } from './mcp-tools.js';
export type ToolExecutor = (name: string, args: unknown, signal: AbortSignal) => Promise<ToolResult>;
export declare function createEpisodicServer({ execute }?: {
    execute?: ToolExecutor;
}): Server;
