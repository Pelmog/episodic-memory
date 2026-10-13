import { Server } from '@modelcontextprotocol/server';
import { TOOL_DEFINITIONS, callTool } from './mcp-tools.js';
import { VERSION } from './version.js';
const inProcess = (name, args, signal) => callTool(name, args, { signal });
// Compile-time check: our definitions must be assignable to the SDK's Tool type, without casts.
const _assignable = TOOL_DEFINITIONS;
void _assignable;
export function createEpisodicServer({ execute = inProcess } = {}) {
    const server = new Server({ name: 'episodic-memory', version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: TOOL_DEFINITIONS }));
    server.setRequestHandler('tools/call', async (request, ctx) => execute(request.params.name, request.params.arguments, ctx.mcpReq.signal));
    return server;
}
