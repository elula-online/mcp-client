/**
 * Standardized tool execution result format
 */
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  status: "success" | "error" | "timeout";
  data?: any;
  error?: ToolError;
  executionTime: number;
  timestamp: Date;
}

export interface ToolError {
  type: "auth" | "not_found" | "invalid_params" | "timeout" | "other";
  message: string;
  recoverable: boolean;
  suggestedAction?: string;
  originalError?: any;
}

/**
 * Tool call metadata
 */
export interface ToolCallMetadata {
  id: string;
  name: string;
  arguments: any;
  signature: string; // Unique signature for deduplication
}

/**
 * Execution context for tool calls
 */
export interface AgentContext {
  toolExecutorMap: Record<string, any>;
  userEmail: string;
  discoveredIds: Map<string, string>;
  toolExecutionHistory: Map<string, ToolExecution>;
  successfulToolCalls: Set<string>;
  cache?: any; // DataCache instance
}

export interface ToolExecution {
  signature: string;
  result: any;
  success: boolean;
  errorType?:
    | "not_found"
    | "invalid_params"
    | "missing_id"
    | "other"
    | "user_auth_error";
  timestamp?: Date;
  executionTime?: number;
}
