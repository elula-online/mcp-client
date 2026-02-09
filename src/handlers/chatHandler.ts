import type { Agent } from "agents";
import type { Env, Message } from "../types";
import systemPrompt from "../systemPrompt";
import { initializeMcpConnection } from "./mcpConnection";
import { AgentState, AgentLoopState } from "../state/AgentState";
import { ToolExecutor } from "../services/ToolExecutor";
import { ErrorRecoveryService } from "../services/ErrorRecoveryService";
import { ResponseValidator } from "../services/ResponseValidator";
import { DataFetcher } from "../services/DataFetcher";
import { getGlobalCache } from "./cacheHandler";
import type { ExecutionContext } from "../models/ToolResult";

/**
 * Handle chat endpoint - main agent loop with improved architecture
 */
export async function handleChatRequest(
  request: Request,
  agent: Agent<Env, never>
): Promise<Response> {
  try {
    const { prompt, email } = (await request.json()) as {
      prompt: string;
      email: string;
    };

    // Initialize services
    const toolExecutor = new ToolExecutor();
    const errorRecovery = new ErrorRecoveryService();
    const validator = new ResponseValidator();
    const dataCache = getGlobalCache(); // Use global cache
    const dataFetcher = new DataFetcher();

    // Check connection state before attempting to use tools
    const servers = await agent.mcp.listServers();
    const connectedServers = servers.filter(
      (s: any) => s.name === "SystemMCPportal" && s.id,
    );

    if (connectedServers.length === 0) {
      console.warn("[Chat] No connected MCP servers available");
      await initializeMcpConnection(agent);
      const serversAfterReconnect = await agent.mcp.listServers();
      const reconnectedServers = serversAfterReconnect.filter(
        (s: any) => s.state === "connected",
      );

      if (reconnectedServers.length === 0) {
        return Response.json(
          {
            error: "No connected MCP servers available",
            suggestion:
              "The MCP portal may be down or unreachable. Please try again later.",
          },
          { status: 503 },
        );
      }
    }

    // Fetch tools with retry logic
    let attempts = 0;
    const MAX_ATTEMPTS = 5;
    let mcpToolsResult: Record<string, any> = {};

    while (
      Object.keys(mcpToolsResult).length === 0 &&
      attempts < MAX_ATTEMPTS
    ) {
      try {
        mcpToolsResult = await agent.mcp.getAITools();
        if (Object.keys(mcpToolsResult).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } catch (error) {
        console.error(`[Chat] Tool fetch error:`, error);
      }
      attempts++;
    }

    if (Object.keys(mcpToolsResult).length === 0) {
      return Response.json(
        { error: "No MCP tools available after retry" },
        { status: 503 },
      );
    }

    const gateway = agent.env.AI.gateway(agent.env.GATEWAY_ID);
    const toolExecutorMap: Record<string, any> = {};

    const tools = Object.entries(mcpToolsResult).map(
      ([toolKey, tool]: [string, any]) => {
        toolExecutorMap[toolKey] = tool;
        return {
          type: "function",
          function: {
            name: toolKey,
            description: tool.description,
            parameters: tool.inputSchema.jsonSchema,
          },
        };
      },
    );

    // Populate cache with channels and users (if not already cached)
    console.log("[Chat] Checking data cache...");
    await dataFetcher.refreshIfNeeded(toolExecutorMap, email, dataCache);
    
    const cacheStats = dataCache.getStats();
    const cachePopulated = !dataCache.isEmpty();
    
    if (cachePopulated) {
      console.log(
        `[Chat] Cache loaded: ${cacheStats.channelCount} channels, ${cacheStats.userCount} users`,
      );
    }

    // Create enhanced system prompt with cached data
    const enhancedSystemPrompt = cachePopulated
      ? `${systemPrompt}

## IMPORTANT: Available Resources (Pre-loaded for Quick Access)

You have immediate access to the following channels and users. Use these directly - NO need to search!

${dataCache.formatCompactChannelsForLLM()}

${dataCache.formatCompactUsersForLLM()}

**CRITICAL INSTRUCTIONS:**
- ✅ For channels/users listed above: Use them DIRECTLY by name (no search needed!)
- ✅ When user asks about a listed channel: Use the exact channel name immediately
- ✅ When user asks about a listed user: Use the exact username immediately
- ❌ DO NOT call search tools for channels/users in the list above
- ⚠️ Only use search if the channel/user is NOT in the list

**Examples:**
- User: "Summarize #engineering" → You see engineering in the list → Use it directly!
- User: "Get info on @john" → You see john in the list → Use it directly!

This data is cached and updated every 5 minutes. Current cache: ${cacheStats.channelCount} channels, ${cacheStats.userCount} users.`
      : systemPrompt;

    // Initialize agent state with enhanced prompt
    const state = new AgentState(enhancedSystemPrompt, prompt);
    state.transitionTo(AgentLoopState.AWAITING_LLM_RESPONSE);

    // Create execution context with cache
    const context: ExecutionContext = {
      toolExecutorMap,
      userEmail: email,
      discoveredIds: state.discoveredIds,
      toolExecutionHistory: state.toolExecutionHistory,
      successfulToolCalls: state.successfulToolCalls,
      cache: dataCache,
    };

    // Main agent loop
    while (state.canContinue()) {
      state.incrementLoop();
      console.log(`[Agent] Loop ${state.loopCount}/10 - State: ${state.state}`);

      const shouldForceAnswer = state.loopCount >= 9;

      // Add initial guidance on first loop
      if (state.loopCount === 1) {
        state.addMessage(validator.createInitialGuidance());
      }

      // Call LLM
      const response = await gateway.run({
        provider: "openai",
        endpoint: "chat/completions",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${agent.env.OPENAI_API_KEY}`,
        },
        query: {
          model: "gpt-4o",
          messages: state.messages,
          tools: shouldForceAnswer ? [] : tools,
          tool_choice: shouldForceAnswer ? "none" : "auto",
          max_tokens: 1000,
        },
      });

      const result = await response.json();

    


      // Validate OpenAI response format
      if (!result.choices || !result.choices[0]) {
        return Response.json(
          { error: "Gateway Error", details: result },
          { status: 500 },
        );
      }

      const choice = result.choices[0];
      const toolCalls = choice.message?.tool_calls || [];
      const assistantContent = choice.message?.content || "";

    

      // Handle text response (no tool calls)
      if (toolCalls.length === 0) {
        if (assistantContent && assistantContent.trim().length > 0) {
          // Validate the response
          const validation = validator.validate(
            assistantContent,
            state.loopCount,
            10,
          );

          if (!validation.isValid && validation.correctionMessage) {
            // Response has issues - ask LLM to fix it
            state.addMessage({
              role: "assistant",
              content: assistantContent,
            });
            state.addMessage(validation.correctionMessage);
            continue;
          }

          // Response is valid - we're done!
          state.addMessage({
            role: "assistant",
            content: assistantContent,
          });
          state.transitionTo(AgentLoopState.COMPLETED);
          break;
        } else {
          // No content and no tool calls - prompt for response
          console.warn(
            "[Agent] LLM provided neither tool calls nor text response",
          );
          state.addMessage(validator.createNoResponseMessage());
          continue;
        }
      }

      // Handle tool calls - execute with parallel support
      if (toolCalls.length > 0) {
        state.transitionTo(AgentLoopState.EXECUTING_TOOLS);

        // Add assistant message with tool calls
        const assistantMessage: Message = {
          role: "assistant",
          content: assistantContent || "",
          tool_calls: toolCalls,
        };
        state.addMessage(assistantMessage);

        // Execute all tool calls (parallel when possible)
        const toolResults = await toolExecutor.executeToolCalls(
          toolCalls,
          context,
        );

        let hasProgress = false;
        let hasCriticalError = false;

        // Process results
        for (const result of toolResults) {
          console.log(
            `[Agent] Tool ${result.toolName}: ${result.status} (${result.executionTime}ms)`,
          );

          // Add tool result to messages
          state.addMessage({
            role: "tool",
            tool_call_id: result.toolCallId,
            name: result.toolName,
            content: result.data || JSON.stringify(result.error),
          });

          if (result.status === "success") {
            // Record success
            const argsString = JSON.stringify(
              toolCalls.find((tc: any) => tc.id === result.toolCallId)?.arguments ||
                {},
            );
            const signature = `${result.toolName}::${argsString}`;
            state.recordToolExecution(signature, result.data, true);
            hasProgress = true;
          } else {
            // Handle error
            state.recordToolFailure(result.toolName);

            // Check if it's a critical error (auth)
            if (errorRecovery.isCriticalError(result)) {
              hasCriticalError = true;
              const recoveryAction = errorRecovery.getRecoveryAction(result, {
                discoveredIds: state.discoveredIds,
                originalArgs:
                  toolCalls.find((tc: any) => tc.id === result.toolCallId)
                    ?.arguments || {},
                consecutiveFailures: state.consecutiveFailures,
                userEmail: email,
              });

              if (recoveryAction.message) {
                state.addMessage(recoveryAction.message);
              }
              break;
            }

            // Check for repeated failures
            if (state.shouldForceFinalResponse()) {
              console.warn(
                `[Agent] Repeated failures detected for ${result.toolName}`,
              );
              state.addMessage(
                errorRecovery.createRepeatedFailureMessage(
                  result.toolName,
                  state.consecutiveFailures,
                ),
              );
              break;
            }

            // Try to recover from error
            const recoveryAction = errorRecovery.getRecoveryAction(result, {
              discoveredIds: state.discoveredIds,
              originalArgs:
                toolCalls.find((tc: any) => tc.id === result.toolCallId)
                  ?.arguments || {},
              consecutiveFailures: state.consecutiveFailures,
              userEmail: email,
            });

            if (recoveryAction.message) {
              state.addMessage(recoveryAction.message);
              state.transitionTo(AgentLoopState.RECOVERING_FROM_ERROR);
            }
          }
        }

        // Mark progress if any tool succeeded
        if (hasProgress) {
          state.markProgress();
        }

        // If critical error, force exit
        if (hasCriticalError) {
          state.transitionTo(AgentLoopState.FAILED);
          break;
        }

        // Continue to next loop iteration
        state.transitionTo(AgentLoopState.AWAITING_LLM_RESPONSE);
      }
    }

    // If we've exited the loop without completing, force a final response
    if (state.state !== AgentLoopState.COMPLETED) {
      console.warn(
        `[Agent] Exited loop without completing. State: ${state.state}`,
      );
      state.addMessage(validator.createFinalResponsePrompt());

      // One final attempt to get a response
      const finalResponse = await gateway.run({
        provider: "openai",
        endpoint: "chat/completions",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${agent.env.OPENAI_API_KEY}`,
        },
        query: {
          model: "gpt-4o",
          messages: state.messages,
          tools: [],
          tool_choice: "none",
          max_tokens: 1000,
        },
      });

      const finalResult = await finalResponse.json();
      if (finalResult.choices && finalResult.choices[0]?.message?.content) {
        state.addMessage({
          role: "assistant",
          content: finalResult.choices[0].message.content,
        });
      }

      state.transitionTo(AgentLoopState.COMPLETED);
    }

    // Get final answer and metrics
    const finalAnswer = state.getFinalAnswer();
    const metrics = state.getMetrics();

    console.log(`[Agent] Completed:`, metrics);

    return Response.json({
      status: "success",
      answer: finalAnswer,
      debug: metrics,
    });
  } catch (error) {
    console.error("[Chat] Unexpected error:", error);
    return Response.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
