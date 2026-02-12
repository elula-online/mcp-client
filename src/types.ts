export type Env = {
  MyAgent: any;
  HOST: string;
  MCP_PORTAL_URL: string;
  ACCOUNT_ID: string;
  GATEWAY_ID: string;
  AI: any;
  CLOUDFLARE_API_TOKEN: string;
  CFAccessClientId: string;
  CFAccessClientSecret: string;
  PARAAT_AUTH_SECRET: string;
  OPENAI_API_KEY: string;
};

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  name: string;
  arguments: any;
  id: string;
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
}

export interface ErrorAnalysis {
  errorType:
    | "not_found"
    | "invalid_params"
    | "missing_id"
    | "user_auth_error"
    | "other";
  suggestedRecovery?: string;
  missingParam?: string;
  isRecoverable: boolean;
}
