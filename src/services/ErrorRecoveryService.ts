import type { ToolResult } from "../models/ToolResult";
import type { Message } from "../types";

/**
 * Recovery action to take after error
 */
export interface RecoveryAction {
  type:
    | "retry"
    | "call_helper_tool"
    | "force_response"
    | "inform_user"
    | "none";
  message?: Message;
  helperTool?: string;
  modifiedArgs?: any;
}

/**
 * Recovery strategy interface
 */
export interface RecoveryStrategy {
  canHandle(result: ToolResult): boolean;
  recover(result: ToolResult, context: RecoveryContext): RecoveryAction;
}

/**
 * Context for recovery strategies
 */
export interface RecoveryContext {
  discoveredIds: Map<string, string>;
  originalArgs: any;
  consecutiveFailures: number;
  userEmail: string;
}

/**
 * Authentication Error Strategy
 */
class AuthErrorStrategy implements RecoveryStrategy {
  canHandle(result: ToolResult): boolean {
    return result.error?.type === "auth";
  }

  recover(result: ToolResult, context: RecoveryContext): RecoveryAction {
    console.warn(
      `[Recovery] Auth error detected for tool ${result.toolName}`,
    );

    return {
      type: "force_response",
      message: {
        role: "user",
        content: `CRITICAL ERROR: User authentication failed.

The email "${context.userEmail}" is not found in the Mattermost system or lacks permissions.

You MUST STOP attempting to call tools and inform the user:
"It appears your email address (${context.userEmail}) is not registered in the Mattermost system or you don't have the necessary permissions. Please contact your administrator to:
1. Be added to Mattermost
2. Be added to the necessary channels
3. Verify your permissions

Once your account is set up, you'll be able to access channel information."

DO NOT retry this operation. Respond to the user immediately with this message.`,
      },
    };
  }
}

/**
 * Not Found Error Strategy
 */
class NotFoundStrategy implements RecoveryStrategy {
  canHandle(result: ToolResult): boolean {
    return result.error?.type === "not_found";
  }

  recover(result: ToolResult, context: RecoveryContext): RecoveryAction {
    const { discoveredIds, originalArgs } = context;

    // Check if we used a valid Mattermost ID (26 chars) and it still failed
    const isMattermostId = /^[a-z0-9]{26}$/i.test(
      originalArgs.channel || "",
    );

    if (result.toolName.includes("summarize") && isMattermostId) {
      console.warn(
        `[Recovery] Valid ID failed - bot likely not member of channel`,
      );
      return {
        type: "force_response",
        message: {
          role: "user",
          content: `CRITICAL FAILURE: You attempted to use a specific Channel ID ("${originalArgs.channel}"), but it returned 404/Not Found.

Since this is a valid ID pattern, this error means **THE BOT IS NOT A MEMBER OF THE CHANNEL**.

STOP SEARCHING. STOP RETRYING.
Inform the user that the channel exists but the bot needs to be added to it to read messages.`,
        },
      };
    }

    // Check if we already have the ID cached from previous searches
    const channelName = originalArgs.channel
      ?.toLowerCase()
      .replace(/\s+/g, "-");

    if (channelName && discoveredIds.has(channelName)) {
      const channelId = discoveredIds.get(channelName);
      console.log(
        `[Recovery] Using cached channel ID: ${channelId}`,
      );

      return {
        type: "retry",
        modifiedArgs: {
          ...originalArgs,
          channel: channelId,
        },
        message: {
          role: "user",
          content: `CRITICAL INSTRUCTION: The channel ID for "${originalArgs.channel}" is already known: ${channelId}

You MUST now call ${result.toolName} again with these EXACT parameters:
- channel: "${channelId}"
- Keep all other parameters the same

DO NOT search again. USE THE ID ABOVE.`,
        },
      };
    }

    // Also check with original name (without replacement)
    const originalChannelName = originalArgs.channel?.toLowerCase();
    if (originalChannelName && discoveredIds.has(originalChannelName)) {
      const channelId = discoveredIds.get(originalChannelName);
      console.log(
        `[Recovery] Using cached channel ID (original): ${channelId}`,
      );

      return {
        type: "retry",
        modifiedArgs: {
          ...originalArgs,
          channel: channelId,
        },
        message: {
          role: "user",
          content: `The channel ID for "${originalArgs.channel}" is: ${channelId}

Retry ${result.toolName} with channel: "${channelId}"`,
        },
      };
    }

    // Suggest using search tool to find the ID
    if (originalArgs.channel && !originalArgs.channel_id) {
      console.log(
        `[Recovery] Suggesting search for channel: ${originalArgs.channel}`,
      );

      return {
        type: "call_helper_tool",
        helperTool: "search_channels",
        message: {
          role: "user",
          content: `The channel "${originalArgs.channel}" was not found.

STEP 1: Call 'mattermost_search_channels' with search_term: "${originalArgs.channel}"
STEP 2: Use the 'id' from the results to retry ${result.toolName}`,
        },
      };
    }

    if (originalArgs.username && !originalArgs.user_id) {
      return {
        type: "call_helper_tool",
        helperTool: "get_users",
        message: {
          role: "user",
          content: `The user "${originalArgs.username}" was not found.

STEP 1: Call 'mattermost_get_users' to see available users
STEP 2: Find the correct username similar to "${originalArgs.username}"
STEP 3: Retry ${result.toolName} with the correct username`,
        },
      };
    }

    // Generic not found - can't recover
    return {
      type: "inform_user",
      message: {
        role: "user",
        content: `The requested resource was not found. Please analyze the error and provide the best response you can based on the information available.`,
      },
    };
  }
}

/**
 * Invalid Parameters Strategy
 */
class InvalidParamsStrategy implements RecoveryStrategy {
  canHandle(result: ToolResult): boolean {
    return result.error?.type === "invalid_params";
  }

  recover(result: ToolResult, context: RecoveryContext): RecoveryAction {
    console.warn(
      `[Recovery] Invalid params for tool ${result.toolName}`,
    );

    return {
      type: "inform_user",
      message: {
        role: "user",
        content: `The tool ${result.toolName} was called with invalid parameters. 

Error: ${result.error?.message}

Please analyze the error and try again with corrected parameters, or inform the user about the issue.`,
      },
    };
  }
}

/**
 * Timeout Strategy
 */
class TimeoutStrategy implements RecoveryStrategy {
  canHandle(result: ToolResult): boolean {
    return result.error?.type === "timeout" || result.status === "timeout";
  }

  recover(result: ToolResult, context: RecoveryContext): RecoveryAction {
    console.warn(`[Recovery] Timeout for tool ${result.toolName}`);

    // Only retry once on timeout
    if (context.consecutiveFailures < 1) {
      return {
        type: "retry",
        message: {
          role: "user",
          content: `The tool ${result.toolName} timed out. Retrying once more...`,
        },
      };
    }

    return {
      type: "inform_user",
      message: {
        role: "user",
        content: `The tool ${result.toolName} timed out after multiple attempts. Inform the user that the operation is taking too long and they should try again later.`,
      },
    };
  }
}

/**
 * Error Recovery Service
 * Uses strategy pattern to handle different error types
 */
export class ErrorRecoveryService {
  private strategies: RecoveryStrategy[] = [
    new AuthErrorStrategy(),
    new NotFoundStrategy(),
    new InvalidParamsStrategy(),
    new TimeoutStrategy(),
  ];

  /**
   * Get recovery action for a failed tool result
   */
  getRecoveryAction(
    result: ToolResult,
    context: RecoveryContext,
  ): RecoveryAction {
    // Find appropriate strategy
    const strategy = this.strategies.find((s) => s.canHandle(result));

    if (strategy) {
      return strategy.recover(result, context);
    }

    // No specific strategy - generic handling
    return {
      type: "inform_user",
      message: {
        role: "user",
        content: `The tool encountered an error: ${result.error?.message || "Unknown error"}. 

Please analyze the error and provide the best response you can based on the information available.`,
      },
    };
  }

  /**
   * Check if error is critical and should immediately end the loop
   */
  isCriticalError(result: ToolResult): boolean {
    return result.error?.type === "auth";
  }

  /**
   * Create message for repeated failures
   */
  createRepeatedFailureMessage(toolName: string, failureCount: number): Message {
    return {
      role: "user",
      content: `You have attempted to use ${toolName} ${failureCount} times without success. 

Based on all the information you've gathered so far, please provide a helpful response to the user explaining:
1. What you attempted to do
2. What you found (if anything)
3. What the issue might be

Do not attempt to use ${toolName} again. Use the data from previous tool results to give an informative response. Do not just read out tool call arguments.`,
    };
  }

  /**
   * Create message to block duplicate calls
   */
  createDuplicateCallMessage(): Message {
    return {
      role: "user",
      content: `CRITICAL: You are trying to repeat an action that was already completed successfully.

You MUST stop calling tools and provide a user-friendly response NOW. Please use line breaks and formatting.

Requirements:
- Confirm what was done
- Use no technical terms
- Be brief and friendly

Respond to the user immediately.`,
    };
  }
}
