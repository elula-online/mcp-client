import type { ToolResult, ToolCallMetadata, AgentContext } from "../models/ToolResult";
import { parseToolOutput, extractErrorMessage } from "../utils/resultParser";
import { sanitizeToolArgs, extractDiscoveredIds } from "../utils/toolUtils";

/**
 * Tool dependency analysis result
 */
interface DependencyAnalysis {
  independent: ToolCallMetadata[];
  dependent: ToolCallMetadata[];
}

/**
 * ToolExecutor handles parallel and sequential tool execution
 */
export class ToolExecutor {
  /**
   * Execute multiple tool calls with automatic parallel/sequential execution
   */
  async executeToolCalls(
    toolCalls: any[],
    context: AgentContext,
  ): Promise<ToolResult[]> {
    if (toolCalls.length === 0) return [];

    console.log(`[ToolExecutor] Processing ${toolCalls.length} tool call(s)`);

    // Convert to metadata format
    const metadata = this.prepareToolCallMetadata(toolCalls, context);

    // Analyze dependencies
    const { independent, dependent } = this.analyzeDependencies(metadata);

    console.log(
      `[ToolExecutor] Independent: ${independent.length}, Dependent: ${dependent.length}`,
    );

    const results: ToolResult[] = [];

    // Execute independent calls in parallel
    if (independent.length > 0) {
      const parallelResults = await this.executeParallel(independent, context);
      results.push(...parallelResults);
    }

    // Execute dependent calls sequentially
    if (dependent.length > 0) {
      const sequentialResults = await this.executeSequential(
        dependent,
        context,
      );
      results.push(...sequentialResults);
    }

    return results;
  }

  /**
   * Prepare tool call metadata
   */
  private prepareToolCallMetadata(
    toolCalls: any[],
    context: AgentContext,
  ): ToolCallMetadata[] {
    return toolCalls.map((toolCall) => {
      const name = toolCall.function?.name || toolCall.name;
      const args = toolCall.function?.arguments || toolCall.arguments;
      const callId = toolCall.id;

      // Parse and sanitize arguments
      let parsedArgs =
        typeof args === "string" ? JSON.parse(args) : { ...args };
      parsedArgs = sanitizeToolArgs(name, parsedArgs, context.userEmail);

      // Create unique signature
      const argsString = JSON.stringify(parsedArgs);
      const signature = `${name}::${argsString}`;

      return {
        id: callId,
        name,
        arguments: parsedArgs,
        signature,
      };
    });
  }

  /**
   * Analyze dependencies between tool calls
   * Independent calls can run in parallel, dependent ones must be sequential
   */
  private analyzeDependencies(
    toolCalls: ToolCallMetadata[],
  ): DependencyAnalysis {
    if (toolCalls.length <= 1) {
      return { independent: toolCalls, dependent: [] };
    }

    const independent: ToolCallMetadata[] = [];
    const dependent: ToolCallMetadata[] = [];

    // Simple heuristic: Tools that don't share resource identifiers can run in parallel
    // Tools that reference the same channel, user, or post must run sequentially
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      let hasDependency = false;

      for (let j = 0; j < i; j++) {
        if (this.hasResourceOverlap(call, toolCalls[j])) {
          hasDependency = true;
          break;
        }
      }

      if (hasDependency) {
        dependent.push(call);
      } else {
        independent.push(call);
      }
    }

    return { independent, dependent };
  }

  /**
   * Check if two tool calls operate on the same resource
   */
  private hasResourceOverlap(call1: ToolCallMetadata, call2: ToolCallMetadata): boolean {
    const args1 = call1.arguments;
    const args2 = call2.arguments;

    // Check for shared identifiers
    const identifierKeys = [
      "channel",
      "channel_id",
      "user_id",
      "username",
      "post_id",
      "thread_id",
    ];

    for (const key of identifierKeys) {
      if (args1[key] && args2[key] && args1[key] === args2[key]) {
        return true;
      }
    }

    // If one call is searching for something the other needs, they're dependent
    if (call1.name.includes("search") && !call2.name.includes("search")) {
      return true;
    }

    return false;
  }

  /**
   * Execute tool calls in parallel using Promise.allSettled
   */
  private async executeParallel(
    toolCalls: ToolCallMetadata[],
    context: AgentContext,
  ): Promise<ToolResult[]> {
    console.log(`[ToolExecutor] Executing ${toolCalls.length} calls in parallel`);

    const promises = toolCalls.map((call) =>
      this.executeSingleTool(call, context),
    );

    const results = await Promise.allSettled(promises);

    return results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        // Promise rejected - create error result
        return this.createErrorResult(
          toolCalls[index],
          result.reason,
          context,
        );
      }
    });
  }

  /**
   * Execute tool calls sequentially
   */
  private async executeSequential(
    toolCalls: ToolCallMetadata[],
    context: AgentContext,
  ): Promise<ToolResult[]> {
    console.log(`[ToolExecutor] Executing ${toolCalls.length} calls sequentially`);

    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      try {
        const result = await this.executeSingleTool(call, context);
        results.push(result);
      } catch (error) {
        results.push(this.createErrorResult(call, error, context));
      }
    }

    return results;
  }

  /**
   * Execute a single tool call
   */
  private async executeSingleTool(
    call: ToolCallMetadata,
    context: AgentContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    // Check for duplicate calls
    if (context.successfulToolCalls.has(call.signature)) {
      console.warn(
        `[ToolExecutor] Skipping duplicate call: ${call.name}`,
      );
      const previousResult = context.toolExecutionHistory.get(call.signature)
        ?.result;
      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "success",
        data: previousResult || "Action completed successfully.",
        executionTime: 0,
        timestamp: new Date(),
      };
    }

    // Try to resolve from cache first
    const cacheResult = this.tryResolveFromCache(call, context);
    if (cacheResult) {
      console.log(`[ToolExecutor] ✓ Resolved ${call.name} from cache`);
      return cacheResult;
    }

    // Get tool executor
    const tool = context.toolExecutorMap[call.name];
    if (!tool) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "error",
        error: {
          type: "other",
          message: `Tool ${call.name} is not available`,
          recoverable: false,
        },
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }

    try {
      // Execute with timeout (30 seconds)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Tool execution timeout")), 30000);
      });

      const toolOutput = await Promise.race([
        tool.execute(call.arguments),
        timeoutPromise,
      ]);

      const executionTime = Date.now() - startTime;

      // Parse the output
      const parsed = parseToolOutput(toolOutput);

      if (parsed.isError) {
        // Tool returned an error
        return {
          toolCallId: call.id,
          toolName: call.name,
          status: "error",
          error: {
            type: (parsed.errorType as any) || "other",
            message: parsed.content,
            recoverable: parsed.errorType === "not_found",
          },
          executionTime,
          timestamp: new Date(),
        };
      }

      // Success - extract discovered IDs
      extractDiscoveredIds(call.name, parsed.content, context.discoveredIds);

      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "success",
        data: parsed.content,
        executionTime,
        timestamp: new Date(),
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;

      // Handle timeout
      if (error.message === "Tool execution timeout") {
        return {
          toolCallId: call.id,
          toolName: call.name,
          status: "timeout",
          error: {
            type: "timeout",
            message: "Tool execution timed out after 30 seconds",
            recoverable: true,
          },
          executionTime,
          timestamp: new Date(),
        };
      }

      // Extract clean error message
      const errorMessage = extractErrorMessage(error);

      // Determine error type
      const errorType = this.classifyError(errorMessage);

      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "error",
        error: {
          type: errorType,
          message: errorMessage,
          recoverable: errorType === "not_found",
          originalError: error,
        },
        executionTime,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Create error result for failed tool execution
   */
  private createErrorResult(
    call: ToolCallMetadata,
    error: any,
    context: AgentContext,
  ): ToolResult {
    const errorMessage = extractErrorMessage(error);
    const errorType = this.classifyError(errorMessage);

    return {
      toolCallId: call.id,
      toolName: call.name,
      status: "error",
      error: {
        type: errorType,
        message: errorMessage,
        recoverable: false,
        originalError: error,
      },
      executionTime: 0,
      timestamp: new Date(),
    };
  }

  /**
   * Classify error by type
   */
  private classifyError(errorMessage: string): "auth" | "not_found" | "invalid_params" | "timeout" | "other" {
    const lowerMessage = errorMessage.toLowerCase();

    if (
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("permission") ||
      lowerMessage.includes("access denied") ||
      lowerMessage.includes("user not found")
    ) {
      return "auth";
    }

    if (
      lowerMessage.includes("not found") ||
      lowerMessage.includes("404") ||
      lowerMessage.includes("does not exist")
    ) {
      return "not_found";
    }

    if (
      lowerMessage.includes("invalid") ||
      lowerMessage.includes("bad request") ||
      lowerMessage.includes("400")
    ) {
      return "invalid_params";
    }

    if (lowerMessage.includes("timeout") || lowerMessage.includes("timed out")) {
      return "timeout";
    }

    return "other";
  }

  /**
   * Try to resolve tool call from cache
   * Returns ToolResult if resolved, null if needs to execute
   */
  private tryResolveFromCache(
    call: ToolCallMetadata,
    context: AgentContext,
  ): ToolResult | null {
    const cache = context.cache;
    if (!cache) return null;

    const startTime = Date.now();

    // Handle channel search/lookup
    if (
      call.name.toLowerCase().includes("search_channel") ||
      call.name.toLowerCase().includes("get_channel")
    ) {
      const searchTerm = call.arguments.search_term || call.arguments.channel || call.arguments.name;
      if (searchTerm) {
        const channel = cache.getChannel(searchTerm);
        if (channel) {
          return {
            toolCallId: call.id,
            toolName: call.name,
            status: "success",
            data: JSON.stringify({
              channels: [channel],
              found: true,
              source: "cache",
            }),
            executionTime: Date.now() - startTime,
            timestamp: new Date(),
          };
        }
      }
    }

    // Handle user search/lookup
    if (
      call.name.toLowerCase().includes("get_user") ||
      call.name.toLowerCase().includes("search_user")
    ) {
      const userQuery =
        call.arguments.username ||
        call.arguments.email ||
        call.arguments.search_term;
      if (userQuery) {
        const user = cache.getUser(userQuery);
        if (user) {
          return {
            toolCallId: call.id,
            toolName: call.name,
            status: "success",
            data: JSON.stringify({
              users: [user],
              found: true,
              source: "cache",
            }),
            executionTime: Date.now() - startTime,
            timestamp: new Date(),
          };
        }
      }
    }

    return null;
  }
}
