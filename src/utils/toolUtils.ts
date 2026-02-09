import type { ErrorAnalysis } from "../types";

/**
 * Validate and sanitize tool arguments before execution
 */
export function sanitizeToolArgs(
  toolName: string,
  args: any,
  manualEmail?: string,
): any {
  // Safety check: ensure toolName is defined
  if (!toolName) {
    console.error("[sanitizeToolArgs] toolName is undefined!");
    toolName = "unknown_tool";
  }

  const sanitized = { ...args };

  if (manualEmail) {
    sanitized.userEmail = manualEmail;
  }

  for (const key in sanitized) {
    if (typeof sanitized[key] === "string") {
      const lowerValue = sanitized[key].toLowerCase().trim();
      if (lowerValue === "true") {
        sanitized[key] = true;
      } else if (lowerValue === "false") {
        sanitized[key] = false;
      }
    }
  }

  // Convert string numbers to actual numbers for numeric parameters
  const numericParams = [
    "limit",
    "page",
    "message_limit",
    "max_channels",
  ];
  for (const param of numericParams) {
    if (sanitized[param] !== undefined) {
      const value = sanitized[param];
      if (
        typeof value === "string" &&
        value.trim() !== "" &&
        !isNaN(Number(value))
      ) {
        sanitized[param] = Number(value);
      } else if (typeof value === "number") {
        // Keep as is
      } else {
        // Invalid value - remove it to use default
        delete sanitized[param];
      }
    }
  }

  // Validate time_range for summarize_channel
  if (
    toolName.includes("summarize_channel") &&
    sanitized.time_range !== undefined
  ) {
    const validTimeRanges = [
      "today",
      "yesterday",
      "this_week",
      "this_month",
      "all",
    ];
    const isValidFormat =
      validTimeRanges.includes(sanitized.time_range) ||
      /^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/.test(
        sanitized.time_range,
      ) ||
      /^\d{2}\/\d{2}\/\d{4} to \d{2}\/\d{2}\/\d{4}$/.test(
        sanitized.time_range,
      );

    if (!isValidFormat && typeof sanitized.time_range !== "string") {
      sanitized.time_range = "all";
    }
  }

  // Remove 'none' username values that cause errors
  if (sanitized.username === "none" || sanitized.username === "None") {
    delete sanitized.username;
  }

  return sanitized;
}

/**
 * Extract and store discovered IDs from search results
 */
export function extractDiscoveredIds(toolName: string, result: string, discoveredIds: Map<string, string>) {
  if (toolName.includes("search_channels")) {
    try {
      const parsed = JSON.parse(result);
      if (parsed.channels && Array.isArray(parsed.channels)) {
        for (const channel of parsed.channels) {
          if (channel.name && channel.id) {
            discoveredIds.set(channel.name.toLowerCase(), channel.id);
            if (channel.display_name) {
              discoveredIds.set(
                channel.display_name.toLowerCase(),
                channel.id,
              );
            }
          }
        }
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }
}

/**
 * Analyze tool error to determine recovery strategy
 */
export function analyzeToolError(
  toolName: string,
  errorContent: string,
  toolArgs: any,
): ErrorAnalysis {
  // Safety check
  if (!toolName) toolName = "unknown_tool";
  if (!errorContent) errorContent = "";

  const errorLower = errorContent.toLowerCase();

  // Check for user authentication/access errors - CRITICAL: These are NOT recoverable
  if (
    errorLower.includes("user not found") ||
    errorLower.includes("user not found for email") ||
    errorLower.includes("unauthorized") ||
    errorLower.includes("permission denied") ||
    errorLower.includes("access denied") ||
    errorLower.includes("not authorized")
  ) {
    return {
      errorType: "user_auth_error",
      isRecoverable: false,
    };
  }

  // Check for 404 / not found errors
  if (
    errorLower.includes("404") ||
    errorLower.includes("not found") ||
    errorLower.includes("does not exist")
  ) {
    // Determine what's missing
    if (
      errorLower.includes("channel") &&
      !toolArgs.channel_id &&
      toolArgs.channel
    ) {
      return {
        errorType: "not_found",
        suggestedRecovery: "mattermost_search_channels",
        missingParam: "channel_id",
        isRecoverable: true,
      };
    }
    if (errorLower.includes("user") && !toolArgs.user_id) {
      return {
        errorType: "not_found",
        suggestedRecovery: "mattermost_get_users",
        missingParam: "user_id",
        isRecoverable: true,
      };
    }
    if (errorLower.includes("post") || errorLower.includes("thread")) {
      return {
        errorType: "not_found",
        suggestedRecovery: "mattermost_search_messages",
        missingParam: "post_id",
        isRecoverable: true,
      };
    }
    return { errorType: "not_found", isRecoverable: false };
  }

  // Check for invalid parameter errors
  if (
    errorLower.includes("invalid") ||
    errorLower.includes("bad request") ||
    errorLower.includes("400") ||
    errorLower.includes("validation error")
  ) {
    return { errorType: "invalid_params", isRecoverable: false };
  }

  return { errorType: "other", isRecoverable: false };
}

/**
 * Create smart guidance prompt for LLM after tool error
 */
export function createErrorRecoveryPrompt(
  toolName: string,
  errorAnalysis: ErrorAnalysis,
  originalArgs: any,
  discoveredIdsContext: Map<string, string>,
): string | null {
  if (!errorAnalysis.isRecoverable) {
    // Special handling for user authentication errors
    if (errorAnalysis.errorType === "user_auth_error") {
      return `CRITICAL ERROR: User authentication failed.

The email "${originalArgs.userEmail || "provided"}" is not found in the Mattermost system.

You MUST STOP attempting to call tools and inform the user:
"It appears your email address is not registered in the Mattermost system. Please contact your administrator to:
1. Be added to Mattermost
2. Be added to the necessary channels

Once your account is set up, you'll be able to access channel information."

DO NOT retry this operation. Respond to the user immediately with this message.`;
    }
    return null;
  }

  // 1. CRITICAL FIX: Check if we already used a valid ID (26 chars) and it still failed
  // This usually means the channel exists, but the bot isn't a member (Permission Denied/404)
  const isMattermostId = /^[a-z0-9]{26}$/i.test(
    originalArgs.channel || "",
  );

  if (
    toolName.includes("summarize_channel") &&
    isMattermostId &&
    errorAnalysis.errorType === "not_found"
  ) {
    return `CRITICAL FAILURE: You attempted to use a specific Channel ID ("${originalArgs.channel}"), but it returned 404/Not Found.

Since this is a valid ID pattern, this error means **THE BOT IS NOT A MEMBER OF THE CHANNEL**.

STOP SEARCHING. STOP RETRYING.
Immediate Action: Inform the user that you found the channel but need to be added to it to read messages.`;
  }

  // 2. Standard Recovery: Check if we already have the ID mapped from previous searches
  const channelName = originalArgs.channel
    ?.toLowerCase()
    .replace(/\s+/g, "-");
  if (channelName && discoveredIdsContext.has(channelName)) {
    const channelId = discoveredIdsContext.get(channelName);
    return `CRITICAL INSTRUCTION: The channel ID for "${originalArgs.channel}" is already known: ${channelId}

You MUST now call ${toolName} again with these EXACT parameters:
- channel: "${channelId}"
- Keep all other parameters the same

DO NOT search again. USE THE ID ABOVE.`;
  }

  // Also check with original name (without replacement)
  const originalChannelName = originalArgs.channel?.toLowerCase();
  if (
    originalChannelName &&
    discoveredIdsContext.has(originalChannelName)
  ) {
    const channelId = discoveredIdsContext.get(originalChannelName);
    return `CRITICAL INSTRUCTION: The channel ID for "${originalArgs.channel}" is already known: ${channelId}

You MUST now call ${toolName} again with these EXACT parameters:
- channel: "${channelId}"
- Keep all other parameters the same

DO NOT search again. USE THE ID ABOVE.`;
  }

  // 3. If ID not discovered yet, provide ONE-TIME search instruction
  if (
    errorAnalysis.suggestedRecovery === "mattermost_search_channels"
  ) {
    return `CRITICAL: The channel "${originalArgs.channel}" was not found.
    
You must resolve the channel name to an ID.
STEP 1: Call 'mattermost_search_channels' with search_term: "${originalArgs.channel}".
STEP 2: Use the 'id' from the results to retry your request.`;
  }

  if (errorAnalysis.suggestedRecovery === "mattermost_get_users") {
    return `CRITICAL: The user "${originalArgs.username || "target"}" was not found. 
    
You cannot proceed without a valid username. 
STEP 1: Call 'mattermost_get_users' immediately to see the full list of members.
STEP 2: Find the correct username that looks like "${originalArgs.username}".
STEP 3: Retry your original request with the correct username found in the list.`;
  }

  if (
    errorAnalysis.suggestedRecovery === "mattermost_search_messages"
  ) {
    return `The post/thread was not found.

NEXT STEP: Call mattermost_search_messages or mattermost_search_threads to find the conversation, extract the post_id, and retry ${toolName} with the correct post_id.`;
  }

  return null;
}
