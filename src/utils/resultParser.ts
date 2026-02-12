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
  let strategyUsed = "";

  // Strategy 1: MCP standard format with nested content (with result wrapper)
  if (rawOutput?.result?.content?.[0]?.text) {
    content = rawOutput.result.content[0].text;
    strategyUsed = "result.content[0].text";
  }
  // Strategy 2: MCP format with direct content array (no result wrapper)
  else if (rawOutput?.content?.[0]?.text) {
    content = rawOutput.content[0].text;
    strategyUsed = "content[0].text";
  }
  // Strategy 3: Direct string response
  else if (typeof rawOutput === "string") {
    content = rawOutput;
    strategyUsed = "direct string";
  }
  // Strategy 4: Stringify object
  else {
    content = JSON.stringify(rawOutput);
    strategyUsed = "stringified object";
  }

  // Try to parse nested JSON if present
  try {
    const parsed = JSON.parse(content);
    if (parsed.content?.[0]?.text) {
      content = parsed.content[0].text;
      strategyUsed += " -> nested content[0].text";
    }
  } catch {
    // Not nested JSON, use as-is
  }

  console.log(`[resultParser] Strategy: ${strategyUsed}, Content length: ${content.length}`);

  // Detect if this is an error response
  const isError = detectError(content);
  const errorType = isError ? detectErrorType(content) : undefined;

  if (isError) {
    console.log(`[resultParser] Detected as error (${errorType}), content preview:`, content.substring(0, 200));
  }

  return { content, isError, errorType };
}

/**
 * Detect if content represents an error
 * More robust than simple string matching
 */
function detectError(content: string): boolean {
  if (!content) return false;

  const contentLower = content.toLowerCase();

  // First, try to parse as JSON to check structure
  try {
    const parsed = JSON.parse(content);
    
    // Check for explicit error fields in JSON
    if (parsed.error !== undefined && parsed.error !== null) {
      return true;
    }
    
    if (parsed.success === false && parsed.error) {
      return true;
    }
    
    // If it has data/results/channels/users fields, it's likely valid data
    if (parsed.channels || parsed.users || parsed.data || parsed.results) {
      return false;
    }
  } catch {
    // Not valid JSON, continue with string checks
  }

  // Check for explicit error indicators (must be in a clear error context)
  if (
    contentLower.includes('"error":') ||
    contentLower.includes('"success": false')
  ) {
    return true;
  }

  // Check for HTTP error status codes in response
  if (/\b(404|400|401|403|500|502|503)\b/.test(contentLower) && 
      (contentLower.includes('status') || contentLower.includes('code'))) {
    return true;
  }

  // Check for common error phrases at the start of content
  const errorPhrases = [
    "error:",
    "exception:",
    "failed to ",
    "unable to ",
  ];

  const contentStart = contentLower.substring(0, 100);
  return errorPhrases.some((phrase) => contentStart.includes(phrase));
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
