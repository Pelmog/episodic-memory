/**
 * SDK-agnostic MCP tool surface for Episodic Memory: tool definitions and the
 * call handler. Transport layers (stdio today, HTTP later) wrap callTool().
 */
export type ToolDefinition = {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
};
export type ToolResult = {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
};
export type ToolCallOptions = {
    /** Maps/validates the requested read path; throw to refuse. Default: existence check on the path as given. */
    resolveReadPath?: (requested: string) => string;
    signal?: AbortSignal;
};
export declare const TOOL_DEFINITIONS: ToolDefinition[];
export declare function callTool(name: string, args: unknown, options?: ToolCallOptions): Promise<ToolResult>;
