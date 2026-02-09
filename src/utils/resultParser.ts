/**
 * Centralized tool result parsing logic
 * Handles various nested JSON formats from MCP tools
 */

export interface ParsedToolOutput {
  content: string;
  isError: boolean;
  errorType?: string;
}

/**
 * Parse tool output with multiple fallback strategies
 */
export function parseToolOutput(rawOutput: any): ParsedToolOutput {
  let content = "";

  // Strategy 1: MCP standard format with nested content
  if (rawOutput?.result?.content?.[0]?.text) {
    content = rawOutput.result.content[0].text;
  }
  // Strategy 2: Direct string response
  else if (typeof rawOutput === "string") {
    content = rawOutput;
  }
  // Strategy 3: Stringify object
  else {
    content = JSON.stringify(rawOutput);
  }

  // Try to parse nested JSON if present
  try {
    const parsed = JSON.parse(content);
    if (parsed.content?.[0]?.text) {
      content = parsed.content[0].text;
    }
  } catch {
    // Not nested JSON, use as-is
  }

  // Detect if this is an error response
  const isError = detectError(content);
  const errorType = isError ? detectErrorType(content) : undefined;

  return { content, isError, errorType };
}

/**
 * Detect if content represents an error
 * More robust than simple string matching
 */
function detectError(content: string): boolean {
  if (!content) return false;

  const contentLower = content.toLowerCase();

  // Check for explicit error indicators
  if (
    contentLower.includes('"error"') ||
    contentLower.includes('"success": false')
  ) {
    return true;
  }

  // Check for HTTP error codes
  if (
    contentLower.includes("404") ||
    contentLower.includes("400") ||
    contentLower.includes("401") ||
    contentLower.includes("403") ||
    contentLower.includes("500")
  ) {
    return true;
  }

  // Check for common error phrases
  const errorPhrases = [
    "not found",
    "user not found",
    "channel not found",
    "does not exist",
    "failed to",
    "unable to",
    "error:",
    "exception:",
  ];

  return errorPhrases.some((phrase) => contentLower.includes(phrase));
}

/**
 * Classify the type of error
 */
function detectErrorType(content: string): string {
  const contentLower = content.toLowerCase();

  if (
    contentLower.includes("user not found") ||
    contentLower.includes("unauthorized") ||
    contentLower.includes("permission denied") ||
    contentLower.includes("access denied") ||
    contentLower.includes("not authorized")
  ) {
    return "user_auth_error";
  }

  if (
    contentLower.includes("404") ||
    contentLower.includes("not found") ||
    contentLower.includes("does not exist")
  ) {
    return "not_found";
  }

  if (
    contentLower.includes("invalid") ||
    contentLower.includes("bad request") ||
    contentLower.includes("400") ||
    contentLower.includes("validation error")
  ) {
    return "invalid_params";
  }

  if (contentLower.includes("timeout") || contentLower.includes("timed out")) {
    return "timeout";
  }

  return "other";
}

/**
 * Extract clean error message from complex error responses
 */
export function extractErrorMessage(error: any): string {
  if (!error) return "Unknown error";

  let errorMessage = error.message || String(error);

  try {
    // Handle nested JSON errors
    if (errorMessage.includes("{")) {
      const jsonStart = errorMessage.indexOf("{");
      const parsed = JSON.parse(errorMessage.substring(jsonStart));

      if (parsed.error?.message) {
        try {
          const inner = JSON.parse(parsed.error.message);
          return inner.error || parsed.error.message;
        } catch {
          return parsed.error.message;
        }
      }

      if (parsed.message) {
        return parsed.message;
      }
    }

    // Handle "Access Denied" messages
    if (
      errorMessage.includes("Access Denied") ||
      errorMessage.includes("permission")
    ) {
      const cleanMatch = errorMessage.match(/Access Denied:[^"]+/);
      if (cleanMatch) return cleanMatch[0];
    }
  } catch {
    // If parsing fails, use original errorMessage
  }

  return errorMessage;
}
