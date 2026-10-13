#!/usr/bin/env node
/**
 * MCP Server for Episodic Memory.
 *
 * This server provides tools to search and explore indexed Claude Code, Codex, and opencode conversations
 * using semantic search, text search, and conversation display capabilities.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createEpisodicServer } from './mcp-factory.js';

async function main() {
  if (process.argv.includes('--http')) {
    await (await import('./http.js')).startHttp();
    return;
  }
  console.error('Episodic Memory MCP server running via stdio');
  await serveStdio(() => createEpisodicServer());
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
