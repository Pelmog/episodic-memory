#!/usr/bin/env node
/**
 * MCP Server for Episodic Memory.
 *
 * This server provides tools to search and explore indexed Claude Code, Codex, and opencode conversations
 * using semantic search, text search, and conversation display capabilities.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, callTool } from './mcp-tools.js';
import { VERSION } from './version.js';

// Create MCP Server

const server = new Server(
  {
    name: 'episodic-memory',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register Tools

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFINITIONS };
});

// Handle Tool Calls

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return callTool(request.params.name, request.params.arguments);
});

// Main Function

async function main() {
  console.error('Episodic Memory MCP server running via stdio');

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run the Server

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
