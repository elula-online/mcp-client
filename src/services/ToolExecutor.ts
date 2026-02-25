import type { ToolResult, ToolCallMetadata, AgentContext } from "../models/ToolResult";
import { parseToolOutput, extractErrorMessage } from "../utils/resultParser";
import { sanitizeToolArgs, extractDiscoveredIds } from "../utils/toolUtils";

interface DependencyAnalysis {
  independent: ToolCallMetadata[];
  dependent: ToolCallMetadata[];
}

export class ToolExecutor {
  async executeToolCalls(
    toolCalls: any[],
    context: AgentContext,
  ): Promise<ToolResult[]> {
    if (toolCalls.length === 0) return [];

    // console.log(`[ToolExecutor] Processing ${toolCalls.length} tool call(s)`);

    const metadata = this.prepareToolCallMetadata(toolCalls, context);
    const { independent, dependent } = this.analyzeDependencies(metadata);

    // console.log(`[ToolExecutor] Independent: ${independent.length}, Dependent: ${dependent.length}`);

    const results: ToolResult[] = [];

    if (independent.length > 0) {
      results.push(...await this.executeParallel(independent, context));
    }
    if (dependent.length > 0) {
      results.push(...await this.executeSequential(dependent, context));
    }

    return results;
  }

  private prepareToolCallMetadata(
    toolCalls: any[],
    context: AgentContext,
  ): ToolCallMetadata[] {
    return toolCalls.map((toolCall) => {
      const name = toolCall.function?.name || toolCall.name;
      const args = toolCall.function?.arguments || toolCall.arguments;
      const callId = toolCall.id;

      let parsedArgs =
        typeof args === "string" ? JSON.parse(args || "{}") : { ...args };
      parsedArgs = sanitizeToolArgs(name, parsedArgs, context.userEmail);

      const signature = `${name}::${JSON.stringify(parsedArgs)}`;
      return { id: callId, name, arguments: parsedArgs, signature };
    });
  }

  private analyzeDependencies(toolCalls: ToolCallMetadata[]): DependencyAnalysis {
    if (toolCalls.length <= 1) return { independent: toolCalls, dependent: [] };

    const independent: ToolCallMetadata[] = [];
    const dependent: ToolCallMetadata[] = [];

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      let hasDependency = false;
      for (let j = 0; j < i; j++) {
        if (this.hasResourceOverlap(call, toolCalls[j])) {
          hasDependency = true;
          break;
        }
      }
      if (hasDependency) dependent.push(call);
      else independent.push(call);
    }

    return { independent, dependent };
  }

  private hasResourceOverlap(call1: ToolCallMetadata, call2: ToolCallMetadata): boolean {
    const args1 = call1.arguments;
    const args2 = call2.arguments;

    // Mattermost resource identifiers
    const identifierKeys = [
      "channel",
      "channel_id",
      "user_id",
      "username",
      "post_id",
      "thread_id",
    ];

    for (const key of identifierKeys) {
      if (args1[key] && args2[key] && args1[key] === args2[key]) return true;
    }

    // Search results feed into dependent calls
    if (call1.name.includes("search") && !call2.name.includes("search")) return true;

    return false;
  }

  private async executeParallel(
    toolCalls: ToolCallMetadata[],
    context: AgentContext,
  ): Promise<ToolResult[]> {
    // console.log(`[ToolExecutor] Executing ${toolCalls.length} calls in parallel`);
    const results = await Promise.allSettled(
      toolCalls.map((call) => this.executeSingleTool(call, context))
    );
    return results.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : this.createErrorResult(toolCalls[index], result.reason, context)
    );
  }

  private async executeSequential(
    toolCalls: ToolCallMetadata[],
    context: AgentContext,
  ): Promise<ToolResult[]> {
    // console.log(`[ToolExecutor] Executing ${toolCalls.length} calls sequentially`);
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      try {
        results.push(await this.executeSingleTool(call, context));
      } catch (error) {
        results.push(this.createErrorResult(call, error, context));
      }
    }
    return results;
  }

  private async executeSingleTool(
    call: ToolCallMetadata,
    context: AgentContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    // Deduplication: return cached result for identical calls
    if (context.successfulToolCalls.has(call.signature)) {
      // console.warn(`[ToolExecutor] Skipping duplicate call: ${call.name}`);
      const previousResult = context.toolExecutionHistory.get(call.signature)?.result;
      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "success",
        data: previousResult || "Action completed successfully.",
        executionTime: 0,
        timestamp: new Date(),
      };
    }

    // Try to resolve from cache first (Mattermost-specific RAG cache)
    const cacheResult = this.tryResolveFromCache(call, context);
    if (cacheResult) {
      // console.log(`[ToolExecutor] ✓ Resolved ${call.name} from cache`);
      return cacheResult;
    }

    const tool = context.toolExecutorMap[call.name];
    if (!tool) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "error",
        error: { type: "other", message: `Tool ${call.name} is not available`, recoverable: false },
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Tool execution timeout")), 30000)
      );

      const toolOutput = await Promise.race([tool.execute(call.arguments), timeoutPromise]);
      const executionTime = Date.now() - startTime;
      const parsed = parseToolOutput(toolOutput);

      if (parsed.isError) {
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

      // Extract discovered IDs from successful results
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

      if (error.message === "Tool execution timeout") {
        return {
          toolCallId: call.id,
          toolName: call.name,
          status: "timeout",
          error: { type: "timeout", message: "Tool execution timed out after 30 seconds", recoverable: true },
          executionTime,
          timestamp: new Date(),
        };
      }

      const errorMessage = extractErrorMessage(error);
      const errorType = this.classifyError(errorMessage);

      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "error",
        error: { type: errorType, message: errorMessage, recoverable: errorType === "not_found", originalError: error },
        executionTime,
        timestamp: new Date(),
      };
    }
  }

  private createErrorResult(call: ToolCallMetadata, error: any, context: AgentContext): ToolResult {
    const errorMessage = extractErrorMessage(error);
    const errorType = this.classifyError(errorMessage);
    return {
      toolCallId: call.id,
      toolName: call.name,
      status: "error",
      error: { type: errorType, message: errorMessage, recoverable: false, originalError: error },
      executionTime: 0,
      timestamp: new Date(),
    };
  }

  private classifyError(msg: string): "auth" | "not_found" | "invalid_params" | "timeout" | "other" {
    const m = msg.toLowerCase();
    if (
      m.includes("unauthorized") || m.includes("forbidden") || m.includes("permission denied") ||
      m.includes("access denied") || m.includes("not authorized") || m.includes("403") ||
      m.includes("user not found")
    ) return "auth";
    if (m.includes("not found") || m.includes("404") || m.includes("does not exist")) return "not_found";
    if (m.includes("invalid") || m.includes("bad request") || m.includes("400")) return "invalid_params";
    if (m.includes("timeout") || m.includes("timed out")) return "timeout";
    return "other";
  }

  // Mattermost-specific: resolve channel/user lookups from the RAG cache
  private tryResolveFromCache(
    call: ToolCallMetadata,
    context: AgentContext,
  ): ToolResult | null {
    const cache = context.cache;
    if (!cache) return null;

    const startTime = Date.now();

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
            data: JSON.stringify({ channels: [channel], found: true, source: "cache" }),
            executionTime: Date.now() - startTime,
            timestamp: new Date(),
          };
        }
      }
    }

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
            data: JSON.stringify({ users: [user], found: true, source: "cache" }),
            executionTime: Date.now() - startTime,
            timestamp: new Date(),
          };
        }
      }
    }

    return null;
  }
}