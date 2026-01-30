import {
  Agent,
  type AgentNamespace,
  routeAgentRequest,
  getAgentByName,
} from "agents";
import systemPrompt from "./systemPrompt";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;

  HOST: string;
  MCP_PORTAL_URL: string;
  ACCOUNT_ID: string;
  GATEWAY_ID: string;
  AI: any;
  CLOUDFLARE_API_TOKEN: string;
  CFAccessClientId: string;
  CFAccessClientSecret: string;
  PARAAT_AUTH_SECRET: string;
};

// type Message =
//   | {
//       role: "system" | "user" | "assistant";
//       content: string;
//       tool_calls?: any[];
//     }
//   | {
//       role: "tool";
//       content: string;
//       tool_call_id: string;
//       name: string;
//       tool_calls?: never;
//     };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  name: string;
  arguments: any;
  id: string;
}

interface ToolExecution {
  signature: string;
  result: any;
  success: boolean;
  errorType?: "not_found" | "invalid_params" | "missing_id" | "other";
}

export class MyAgent extends Agent<Env, never> {
  async onStart() {
    const portalUrl = this.env.MCP_PORTAL_URL;

    try {
      // Check if we already have a working connection
      const existingServers = await this.mcp.listServers();
      const workingServer = existingServers.find(
        (s: any) => s.name === "SystemMCPportal" && s.state === "connected",
      );

      if (workingServer) {
        console.log(`[Agent] Already connected to portal: ${workingServer.id}`);

        // Verify tools are available
        try {
          const tools = await this.mcp.getAITools();
          const toolCount = Object.keys(tools).length;
          console.log(
            `[Agent] Existing connection has ${toolCount} tools available`,
          );
          return;
        } catch (e) {
          console.warn(
            `[Agent] Existing connection has no tools, will reconnect`,
          );
        }
      }

      // clean up ANY non-connected server
      let cleanedCount = 0;
      for (const server of existingServers) {
        if (server.state !== "connected") {
          console.log(
            `[Agent] Cleaning up ${server.state} connection: ${server.name} (${server.id})`,
          );
          try {
            await this.mcp.removeServer(server.id);
            cleanedCount++;
          } catch (e) {
            console.warn(`[Agent] Failed to remove server ${server.id}:`, e);
          }
        }
      }

      if (cleanedCount > 0) {
        console.log(`[Agent] Cleaned up ${cleanedCount} stale connections`);
      }

      console.log(`[Agent] Connecting to MCP portal: ${portalUrl}`);

      const result = await this.addMcpServer(
        "SystemMCPportal",
        portalUrl,
        "mcp-client-agent",
        undefined,
        {
          transport: {
            type: "streamable-http",
            headers: {
              "CF-Access-Client-Id": this.env.CFAccessClientId,
              "CF-Access-Client-Secret": this.env.CFAccessClientSecret,
            },
          },
        },
      );

      let toolCount = 0;

      // only try to get tools if connection succeeded or is authenticating
      if (result.state === "connected" || result.state === "authenticating") {
        try {
          const tools = await this.mcp.getAITools();
          toolCount = Object.keys(tools).length;
        } catch (e) {
          console.error("[Agent] Error fetching tools:", e);
        }
      } else if (result.state === "failed" || result.state === "error") {
        console.error(`[Agent] Connection failed with state: ${result.state}`);
        // Clean up the failed connection immediately
        try {
          await this.mcp.removeServer(result.id);
          console.log(`[Agent] Removed failed connection: ${result.id}`);
        } catch (e) {
          console.warn(`[Agent] Could not remove failed connection:`, e);
        }
        return;
      }

      if (result.state === "authenticating" && toolCount === 0) {
        console.warn(
          "[Agent] Auth required. Please login:",
          (result as any).authUrl,
        );
        return;
      }

      console.log(
        `[Agent] Connected! ID: ${result.id}, State: ${result.state}`,
      );
      console.log(`[Agent] Success! Found tools: ${toolCount}`);
    } catch (err) {
      console.error("[Agent] Portal Connection Error:", err);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // health check endpoint
    if (url.pathname.endsWith("/health")) {
      try {
        const servers = await this.mcp.listServers();

        // only count tools from connected servers
        const connectedServers = servers.filter(
          (s: any) => s.state === "connected",
        );

        let toolCount = 0;
        if (connectedServers.length > 0) {
          try {
            const mcpTools = await this.mcp.getAITools();
            toolCount = Object.keys(mcpTools).length;
          } catch (e) {
            console.warn("[Health] Could not fetch tools:", e);
          }
        }

        const status = {
          status: toolCount > 0 ? "healthy" : "initializing",
          agent_instance: this.name,
          tools_discovered: toolCount,
          servers: servers.map((s: any) => ({
            name: s.name,
            state: s.state || "unknown",
          })),
          connected_servers: connectedServers.length,
          total_servers: servers.length,
          timestamp: new Date().toISOString(),
        };

        return Response.json(status, { status: toolCount > 0 ? 200 : 503 });
      } catch (error) {
        return Response.json(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          },
          { status: 500 },
        );
      }
    }

    // Tools endpoint
    if (url.pathname.endsWith("/tools")) {
      try {
        const tools = await this.mcp.getAITools();
        return Response.json({ status: "success", tools });
      } catch (error) {
        return Response.json(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 500 },
        );
      }
    }

    // Chat endpoint
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      try {
        const { prompt } = (await request.json()) as { prompt: string };

        // check connection state before attempting to use tools
        const servers = await this.mcp.listServers();
        const connectedServers = servers.filter(
          (s: any) => s.name === "SystemMCPportal" && s.id,
        );

        if (connectedServers.length === 0) {
          console.warn("[Chat] No connected MCP servers available");
          await this.onStart();
          const serversAfterReconnect = await this.mcp.listServers();
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

        // fetch tools with retry logic
        let attempts = 0;
        const MAX_ATTEMPTS = 5;
        let mcpToolsResult: Record<string, any> = {};

        while (
          Object.keys(mcpToolsResult).length === 0 &&
          attempts < MAX_ATTEMPTS
        ) {
          try {
            mcpToolsResult = await this.mcp.getAITools();
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

        const gateway = this.env.AI.gateway(this.env.GATEWAY_ID);
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

        let messages: Message[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ];

        let isRunning = true;
        let loopCount = 0;
        const MAX_LOOPS = 10;

        // Track tool executions with detailed metadata
        const toolExecutionHistory = new Map<string, ToolExecution>();
        const successfulToolCalls = new Set<string>();

        // Track discovered IDs to prevent redundant searches
        const discoveredIds = new Map<string, string>();

        // Validate and sanitize tool arguments before execution
        function sanitizeToolArgs(toolName: string, args: any): any {
          const sanitized = { ...args };

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

        // Extract and store discovered IDs from search results
        function extractDiscoveredIds(toolName: string, result: string) {
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

        // analyze tool error to determine recovery strategy
        function analyzeToolError(
          toolName: string,
          errorContent: string,
          toolArgs: any,
        ): {
          errorType: "not_found" | "invalid_params" | "missing_id" | "other";
          suggestedRecovery?: string;
          missingParam?: string;
          isRecoverable: boolean;
        } {
          const errorLower = errorContent.toLowerCase();

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

        // create smart guidance prompt for LLM after tool error
        function createErrorRecoveryPrompt(
          toolName: string,
          errorAnalysis: ReturnType<typeof analyzeToolError>,
          originalArgs: any,
          discoveredIdsContext: Map<string, string>,
        ): string | null {
          if (!errorAnalysis.isRecoverable) {
            return null;
          }

          // Check if we already have the ID from previous searches
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

          // If ID not discovered yet, provide ONE-TIME search instruction
          if (
            errorAnalysis.suggestedRecovery === "mattermost_search_channels"
          ) {
            return `The channel "${originalArgs.channel}" was not found. 

NEXT STEP: Call mattermost_search_channels ONCE with search_term: "${originalArgs.channel}"

After you get the result, extract the channel ID and call ${toolName} again with that ID.`;
          }

          if (errorAnalysis.suggestedRecovery === "mattermost_get_users") {
            return `The user was not found.

NEXT STEP: Call mattermost_get_users to get all users, find the matching user, extract the user_id, and retry ${toolName} with the correct user_id.`;
          }

          if (
            errorAnalysis.suggestedRecovery === "mattermost_search_messages"
          ) {
            return `The post/thread was not found.

NEXT STEP: Call mattermost_search_messages or mattermost_search_threads to find the conversation, extract the post_id, and retry ${toolName} with the correct post_id.`;
          }

          return null;
        }

        // main agent loop
        let consecutiveFailedAttempts = 0;
        let lastFailedToolName = "";
        let searchLoopCount = 0;

        while (isRunning && loopCount < MAX_LOOPS) {
          loopCount++;
          console.log(`[Agent] Loop ${loopCount}/${MAX_LOOPS}`);

          // Force final answer if we've done too many search loops
          const shouldForceAnswer =
            searchLoopCount >= 2 || loopCount >= MAX_LOOPS - 1;

          const response = await gateway.run({
            provider: "workers-ai",
            endpoint: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN || "LOCAL_AUTH_FALLBACK"}`,
            },
            query: {
              messages: messages,
              tools: shouldForceAnswer ? [] : tools,
              tool_choice: shouldForceAnswer ? "none" : "auto",
              max_tokens: 1000,
            },
          });

          const result = await response.json();
          if (!result.success) {
            return Response.json(
              { error: "Gateway Error", details: result },
              { status: 500 },
            );
          }

          const toolCalls = result.result.tool_calls || [];
          const assistantContent = result.result.response || "";

          // if LLM provides a text response with no tool calls, check for technical jargon
          if (
            toolCalls.length === 0 &&
            assistantContent &&
            assistantContent.trim().length > 0
          ) {
            // Detect if response contains technical jargon that should not be shown to users
            const hasTechnicalJargon =
              /tool_[a-zA-Z0-9_]+_mattermost/i.test(assistantContent) ||
              /\bfunction\b/i.test(assistantContent) ||
              /\bparameter/i.test(assistantContent) ||
              /channel_id.*[a-z0-9]{26}/i.test(assistantContent) ||
              /I was unable to.*using the.*function/i.test(assistantContent) ||
              /I have already provided.*in my previous response/i.test(
                assistantContent,
              );

            if (hasTechnicalJargon && loopCount < MAX_LOOPS - 1) {
              // Force LLM to rewrite without technical details
              console.warn(
                "[Agent] Technical jargon detected in response. Requesting rewrite.",
              );
              messages.push({
                role: "assistant",
                content: assistantContent,
              });
              messages.push({
                role: "user",
                content: `CRITICAL: Your response contains technical implementation details that users should not see. 

Rewrite your response following these rules:
1. NEVER mention tool names, function names, or technical processes
2. Present only the final result or information in a natural, friendly way
3. Use clear formatting with headings and bullet points
4. If something failed, just say what the issue is simply without explaining your troubleshooting process

Rewrite your response now.`,
              });
              continue;
            }

            messages.push({
              role: "assistant",
              content: assistantContent,
            });
            isRunning = false;
            break;
          }

          // If no tool calls and no content, prompt for response
          if (toolCalls.length === 0 && !assistantContent) {
            console.warn(
              "[Agent] LLM provided neither tool calls nor text response",
            );
            messages.push({
              role: "user",
              content: `Provide your answer to the user now based on the information you've gathered. Use clean Markdown formatting and do not mention any technical details.`,
            });
            continue;
          }

          // If LLM wants to call tools, process them
          if (toolCalls.length > 0) {
            // Add assistant message with tool calls
            let assistantMessage: Message = {
              role: "assistant",
              content: assistantContent || "",
            };
            assistantMessage.tool_calls = toolCalls;
            messages.push(assistantMessage);

            // Track if only search/discovery tools are being called
            let onlySearchToolsCalled = toolCalls.every(
              (tc: ToolCall) =>
                tc.name.includes("search") ||
                tc.name.includes("list") ||
                tc.name.includes("get_users") ||
                tc.name.includes("get_channels"),
            );

            if (onlySearchToolsCalled) {
              searchLoopCount++;
            } else {
              searchLoopCount = 0;
            }

            // Process each tool call
            for (const toolCall of toolCalls) {
              const { name, arguments: args, id: callId } = toolCall;

              // Parse and sanitize arguments
              let parsedArgs =
                typeof args === "string" ? JSON.parse(args) : { ...args };
              parsedArgs = sanitizeToolArgs(name, parsedArgs);

              // Create unique signature for this tool call
              const argsString = JSON.stringify(parsedArgs);
              const toolSignature = `${name}::${argsString}`;

              // CONSTRAINT 1: Prevent calling a tool that already succeeded
              if (successfulToolCalls.has(toolSignature)) {
                console.warn(
                  `[Agent] Blocking duplicate call: ${name} - forcing final response`,
                );

                const previousResult =
                  toolExecutionHistory.get(toolSignature)?.result;

                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: previousResult || "Action completed successfully.",
                });

                messages.push({
                  role: "user",
                  content: `CRITICAL: You are trying to repeat an action that was already completed.

You MUST stop calling tools and provide a user-friendly response NOW.

Requirements:
- Confirm what was done
- Use natural language (no technical terms)
- Format with **bold** for emphasis
- Be brief and friendly

Example: "✓ Message sent to **#town-square** successfully!"

Respond to the user immediately.`,
                });

                // Break to force response on next loop
                break;
              }

              const tool = toolExecutorMap[name];
              if (!tool) {
                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: JSON.stringify({
                    error: "Tool not found",
                    details: `Tool ${name} is not available`,
                  }),
                });
                continue;
              }

              try {
                // Execute the tool
                console.log(
                  `[Agent] Executing: ${name} with args:`,
                  parsedArgs,
                );
                const toolOutput = await tool.execute(parsedArgs);

                // Extract clean content from tool output
                let cleanContent;
                if (toolOutput.result?.content?.[0]?.text) {
                  cleanContent = toolOutput.result.content[0].text;
                } else if (typeof toolOutput === "string") {
                  cleanContent = toolOutput;
                } else {
                  cleanContent = JSON.stringify(toolOutput);
                }

                // Try to parse nested JSON if present
                try {
                  const parsed = JSON.parse(cleanContent);
                  if (parsed.content?.[0]?.text) {
                    cleanContent = parsed.content[0].text;
                  }
                } catch {
                  // Not nested JSON, use as-is
                }

                // Check if tool execution was successful
                const isSuccess =
                  !cleanContent.toLowerCase().includes('"error"') &&
                  !cleanContent.toLowerCase().includes('"success": false') &&
                  !cleanContent.toLowerCase().includes("404") &&
                  !cleanContent.toLowerCase().includes("not found");

                if (isSuccess) {
                  // Mark as successful to prevent re-execution
                  successfulToolCalls.add(toolSignature);
                  toolExecutionHistory.set(toolSignature, {
                    signature: toolSignature,
                    result: cleanContent,
                    success: true,
                  });

                  // Extract IDs from search results
                  extractDiscoveredIds(name, cleanContent);

                  messages.push({
                    role: "tool",
                    tool_call_id: callId,
                    name: name,
                    content: cleanContent,
                  });

                  console.log(`[Agent] ✓ Tool ${name} succeeded`);

                  // Reset failure tracking on success
                  consecutiveFailedAttempts = 0;
                  lastFailedToolName = "";

                  // ADD THIS NEW CODE HERE:
                  // ========================
                  // If this was an action tool (not search/list), prompt for immediate response
                  const isActionTool =
                    !name.includes("search") &&
                    !name.includes("list") &&
                    !name.includes("get_users") &&
                    !name.includes("get_channels") &&
                    !name.includes("get_stats");

                  if (isActionTool) {
                    // This was an action (post, reply, add, etc.) - force immediate user response
                    console.log(
                      `[Agent] Action tool succeeded, prompting for user response`,
                    );
                    messages.push({
                      role: "user",
                      content: `Perfect! The action completed successfully. Now provide a brief, friendly confirmation to the user.

Format your response like this:
✓ Done! [Brief description of what was accomplished]

DO NOT call any more tools. Just confirm the action was completed.`,
                    });

                    // Force next iteration to not allow tools
                    searchLoopCount = 999;
                  }
                  // ========================
                } else {
                  // CONSTRAINT 2: Tool failed - analyze error and provide recovery guidance
                  const errorAnalysis = analyzeToolError(
                    name,
                    cleanContent,
                    parsedArgs,
                  );

                  toolExecutionHistory.set(toolSignature, {
                    signature: toolSignature,
                    result: cleanContent,
                    success: false,
                    errorType: errorAnalysis.errorType,
                  });

                  messages.push({
                    role: "tool",
                    tool_call_id: callId,
                    name: name,
                    content: cleanContent,
                  });

                  // Track consecutive failures of the same tool
                  if (lastFailedToolName === name) {
                    consecutiveFailedAttempts++;
                  } else {
                    consecutiveFailedAttempts = 1;
                    lastFailedToolName = name;
                  }

                  // If we've failed 2 times on the same tool, force the agent to respond
                  if (consecutiveFailedAttempts >= 2) {
                    console.warn(
                      `[Agent] Tool ${name} failed ${consecutiveFailedAttempts} times. Forcing final response.`,
                    );
                    messages.push({
                      role: "user",
                      content: `You have attempted to use ${name} multiple times without success. Based on all the information you've gathered so far, please provide a helpful response to the user explaining what you found (if anything) or what the issue might be. Do not attempt to use ${name} again.`,
                    });
                    consecutiveFailedAttempts = 0;
                  } else {
                    // Provide recovery guidance
                    const recoveryPrompt = createErrorRecoveryPrompt(
                      name,
                      errorAnalysis,
                      parsedArgs,
                      discoveredIds,
                    );

                    if (recoveryPrompt) {
                      messages.push({
                        role: "user",
                        content: recoveryPrompt,
                      });
                      console.log(
                        `[Agent] Tool ${name} failed with ${errorAnalysis.errorType}. Providing recovery guidance.`,
                      );
                    } else {
                      messages.push({
                        role: "user",
                        content: `The tool encountered an error. Please analyze the error and provide the best response you can based on the information available.`,
                      });
                      console.log(
                        `[Agent] Tool ${name} failed with non-recoverable error.`,
                      );
                    }
                  }
                }
              } catch (e: any) {
                console.error(`[Agent] Tool execution error:`, e);
                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: JSON.stringify({
                    error: "Tool execution failed",
                    details: e.message,
                  }),
                });

                messages.push({
                  role: "user",
                  content: `The tool ${name} threw an exception: ${e.message}. Please analyze if you need different parameters or a different tool to accomplish the task.`,
                });
              }
            }

            // If we've done 2+ consecutive search loops with successful results, force action
            if (searchLoopCount >= 2 && successfulToolCalls.size > 0) {
              console.warn(
                `[Agent] ${searchLoopCount} consecutive search loops detected. Forcing action or final answer.`,
              );
              messages.push({
                role: "user",
                content: `CRITICAL INSTRUCTION: You have successfully gathered the information. Now provide the final answer.

Requirements for your response:
1. Present ONLY the information the user asked for
2. Use clean Markdown formatting (## headings, **bold**, bullet points)
3. DO NOT mention any tool names or technical processes
4. DO NOT say "I already provided this" - just provide it again in a clean format
5. If listing many items, organize them into logical groups with subheadings

Provide your final answer now.`,
              });
              searchLoopCount = 0;
            }
          }
        }

        if (loopCount >= MAX_LOOPS) {
          console.warn(`[Agent] Reached maximum loop count (${MAX_LOOPS})`);
          messages.push({
            role: "user",
            content: `You must now provide a final response to the user.

Requirements:
1. Use only the information you've gathered from successful tool calls
2. Format cleanly with Markdown (## headings, **bold**, bullet points)
3. Organize information logically (group related items, use subheadings)
4. DO NOT mention tools, functions, or technical processes
5. DO NOT apologize excessively - just provide the best answer you can

Provide your final formatted response now.`,
          });

          // One final attempt to get a response
          const finalResponse = await gateway.run({
            provider: "workers-ai",
            endpoint: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN || "LOCAL_AUTH_FALLBACK"}`,
            },
            query: {
              messages: messages,
              tools: [],
              tool_choice: "none",
              max_tokens: 1000,
            },
          });

          const finalResult = await finalResponse.json();
          if (finalResult.success && finalResult.result.response) {
            messages.push({
              role: "assistant",
              content: finalResult.result.response,
            });
          }
        }

        // Extract final answer from the last assistant message
        const finalAssistantMessage = messages
          .filter(
            (m) =>
              m.role === "assistant" &&
              m.content &&
              m.content.trim().length > 0,
          )
          .pop();

        console.log("Messages: ", finalAssistantMessage);

        let finalAnswer =
          finalAssistantMessage?.content ||
          "I apologize, but I was unable to complete your request. Please try rephrasing or provide more details.";

        return Response.json({
          status: "success",
          answer: finalAnswer,
          debug: {
            loops: loopCount,
            toolExecutions: toolExecutionHistory.size,
            successfulCalls: successfulToolCalls.size,
          },
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

    return new Response(`Agent "${this.name}" active.`, { status: 200 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);

    if (agentResponse) return agentResponse;

    const agent = await getAgentByName(env.MyAgent, "default");

    return agent.fetch(request);
  },
} satisfies ExportedHandler<Env>;
