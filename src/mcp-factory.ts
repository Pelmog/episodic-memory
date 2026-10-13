import { Server, type Tool } from '@modelcontextprotocol/server';
import { TOOL_DEFINITIONS, callTool, type ToolResult } from './mcp-tools.js';
import { VERSION } from './version.js';

export type ToolExecutor = (name: string, args: unknown, signal: AbortSignal) => Promise<ToolResult>;

const inProcess: ToolExecutor = (name, args, signal) => callTool(name, args, { signal });

// Compile-time check: our definitions must be assignable to the SDK's Tool type, without casts.
const _assignable: Tool[] = TOOL_DEFINITIONS;
void _assignable;

export function createEpisodicServer({ execute = inProcess }: { execute?: ToolExecutor } = {}): Server {
  const server = new Server({ name: 'episodic-memory', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler('tools/call', async (request, ctx) =>
    execute(request.params.name, request.params.arguments, ctx.mcpReq.signal));
  return server;
}
