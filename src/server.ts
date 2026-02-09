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
  OPENAI_API_KEY: string;
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
  errorType?:
    | "not_found"
    | "invalid_params"
    | "missing_id"
    | "other"
    | "user_auth_error";
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

    // mattermost Chat endpoint
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      try {
        const { prompt, email } = (await request.json()) as {
          prompt: string;
          email: string;
        };

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
        function sanitizeToolArgs(
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
          errorType:
            | "not_found"
            | "invalid_params"
            | "missing_id"
            | "user_auth_error"
            | "other";
          suggestedRecovery?: string;
          missingParam?: string;
          isRecoverable: boolean;
        } {
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

        // create smart guidance prompt for LLM after tool error
        function createErrorRecoveryPrompt(
          toolName: string,
          errorAnalysis: ReturnType<typeof analyzeToolError>,
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

        // main agent loop
        let consecutiveFailedAttempts = 0;
        let lastFailedToolName = "";

        while (isRunning && loopCount < MAX_LOOPS) {
          loopCount++;
          console.log(`[Agent] Loop ${loopCount}/${MAX_LOOPS}`);

          // FIX: Removed searchLoopCount logic. Only force answer if we hit max safety loops.
          const shouldForceAnswer = loopCount >= MAX_LOOPS - 1;

          // Add guidance on first loop to prevent LLM from describing what it will do
          if (loopCount === 1) {
            messages.push({
              role: "system",
              content: `CRITICAL INSTRUCTION: When you need information, you must IMMEDIATELY call the appropriate tool. DO NOT describe what you plan to do, what parameters you need, or what the request should include. Just call the tool directly.

Example - WRONG: "To get channel statistics, the request should include channel: paraat ai and message_limit: 100"
Example - CORRECT: [Immediately calls the tool with those parameters]

Call tools NOW when needed, don't describe your plan.`,
            });
          }

          const response = await gateway.run({
            provider: "openai",
            endpoint: "chat/completions",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
            },
            query: {
              model: "gpt-5-nano", 
              messages: messages,
              tools: shouldForceAnswer ? [] : tools,
              tool_choice: shouldForceAnswer ? "none" : "auto",
              // max_tokens: 1000,
            },
          });

          const result = await response.json();

          // OpenAI response format
          if (!result.choices || !result.choices[0]) {
            return Response.json(
              { error: "Gateway Error", details: result },
              { status: 500 },
            );
          }

          const choice = result.choices[0];
          const toolCalls = choice.message?.tool_calls || [];
          const assistantContent = choice.message?.content || "";

          // FIX: Detect "Leaky JSON". If LLM outputs raw JSON in text instead of tool_call, reject it.
          // This keeps the LLM in control but enforces protocol.
          if (
            toolCalls.length === 0 &&
            assistantContent.trim().startsWith("{")
          ) {
            if (
              assistantContent.includes('"name":') ||
              assistantContent.includes('"parameters":')
            ) {
              console.warn(
                "[Agent] Detected leaked JSON. Rejecting and prompting for retry.",
              );

              messages.push({
                role: "assistant",
                content: assistantContent, // Log the mistake
              });

              messages.push({
                role: "user",
                content: `SYSTEM ERROR: You outputted the tool call as raw text JSON. 
                   
STOP. Do not write JSON in the response text. 
You must use the 'tool_calls' field protocol to execute tools.
Retry the tool call now correctly.`,
              });

              continue; // Skip rest of loop, force LLM to try again
            }
          }

          // if LLM provides a text response with no tool calls, check for technical jargon
          if (
            toolCalls.length === 0 &&
            assistantContent &&
            assistantContent.trim().length > 0
          ) {
            // Detect if LLM is describing what it WOULD do instead of doing it
            const isDescribingToolCall =
              /the request (should|would|will) include/i.test(
                assistantContent,
              ) ||
              /request details are/i.test(assistantContent) ||
              /to (get|fetch|retrieve).*(the request|I need|should include)/i.test(
                assistantContent,
              ) ||
              /(channel|user|message):\s*[a-z]/i.test(assistantContent);

            if (isDescribingToolCall && loopCount < MAX_LOOPS - 3) {
              console.warn(
                "[Agent] LLM is describing tool parameters instead of calling the tool. Redirecting.",
              );
              messages.push({
                role: "assistant",
                content: assistantContent,
              });
              messages.push({
                role: "user",
                content: `CRITICAL ERROR: You are DESCRIBING what you would do instead of DOING it.

DO NOT explain what parameters you need or what the request should include.
IMMEDIATELY call the appropriate tool with the parameters you just described.

Call the tool NOW.`,
              });
              continue;
            }

            // Detect if response contains technical jargon that should not be shown to users
            const hasTechnicalJargon =
              /tool_[a-zA-Z0-9_]+_mattermost/i.test(assistantContent) ||
              /\bfunction\s+(call|name)/i.test(assistantContent) ||
              /\bparameter(s)?\s+(is|are|was|were)/i.test(assistantContent) ||
              /channel_id.*[a-z0-9]{26}/i.test(assistantContent) ||
              /I was unable to.*using the.*(function|tool)/i.test(
                assistantContent,
              ) ||
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
                content: `CRITICAL: Your response contains technical implementation details that users should not see. Please use line breaks \\n\ and other formatters.

Rewrite your response following these rules:
1. NEVER mention tool names, function names, or technical processes
2. Present only the final result or information in a natural, friendly way
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
              content: `Provide your answer to the user now based on the information you've gathered. Do not mention any technical details. Please use line breaks \\n\ and other formatters.`,
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

            // FIX: Removed "onlySearchToolsCalled" and "searchLoopCount" logic here to allow natural chaining.

            // Process each tool call
            for (const toolCall of toolCalls) {
              // OpenAI format: function name is in toolCall.function.name
              const name = toolCall.function?.name || toolCall.name;
              const args = toolCall.function?.arguments || toolCall.arguments;
              const callId = toolCall.id;

              // Parse and sanitize arguments
              let parsedArgs =
                typeof args === "string" ? JSON.parse(args) : { ...args };
              parsedArgs = sanitizeToolArgs(name, parsedArgs, email);

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

You MUST stop calling tools and provide a user-friendly response NOW. Please use line breaks \\n\ and other formatters

Requirements:
- Confirm what was done
- no technical terms
- Be brief and friendly

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

                  console.log("Tool result: ", cleanContent);
                } catch {
                  // Not nested JSON, use as-is
                }

                // Check if tool execution was successful
                const isSuccess =
                  !cleanContent.toLowerCase().includes('"error"') &&
                  !cleanContent.toLowerCase().includes('"success": false') &&
                  !cleanContent.toLowerCase().includes("404") &&
                  !cleanContent.toLowerCase().includes("not found") &&
                  !cleanContent.toLowerCase().includes("user not found");

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

                  // FIX: Removed the "isActionTool" logic here.
                  // We now let the loop continue so the LLM receives the tool output
                  // and decides whether to chain another tool or answer the user.

                  // Reset failure tracking on success
                  consecutiveFailedAttempts = 0;
                  lastFailedToolName = "";
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

                  // CRITICAL: If this is a user authentication error, immediately force response
                  if (errorAnalysis.errorType === "user_auth_error") {
                    console.warn(
                      `[Agent] User authentication error detected. Forcing immediate user response.`,
                    );

                    const recoveryPrompt = createErrorRecoveryPrompt(
                      name,
                      errorAnalysis,
                      parsedArgs,
                      discoveredIds,
                    );

                    messages.push({
                      role: "user",
                      content:
                        recoveryPrompt ||
                        `CRITICAL: Authentication failed. Inform the user they need to contact their administrator to be added to Mattermost.`,
                    });

                    // Force exit from tool processing loop
                    consecutiveFailedAttempts = 999; // High number to trigger response
                    break;
                  }

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
                      content: `You have attempted to use ${name} multiple times without success. Based on all the information you've gathered so far, please provide a helpful response to the user explaining what you found (if anything) or what the issue might be. Do not attempt to use ${name} again. Do not just read out the results from the tool but you need to use the data from the tool result to give an informative response and if they are juust tool call args do not read them out you need to call the tool`,
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
              } catch (error: any) {
                console.error(`[Agent] Tool execution error:`, error);

                // 1. EXTRACT THE REAL ERROR (Unwrap the nested JSON)
                let errorMessage = error.message || "Unknown error";
                try {
                  // The error is often double-encoded like: {"... message": "{\"error\":\"Access Denied...\"}"}
                  // We try to find the inner JSON structure
                  if (
                    errorMessage.includes("Access Denied") ||
                    errorMessage.includes("permission")
                  ) {
                    // Regex to grab the clean message if parsing fails
                    const cleanMatch =
                      errorMessage.match(/Access Denied:[^"]+/);
                    if (cleanMatch) errorMessage = cleanMatch[0];
                  } else if (errorMessage.includes("{")) {
                    // Try parsing purely to clean it up
                    const parsed = JSON.parse(
                      errorMessage.substring(errorMessage.indexOf("{")),
                    );
                    if (parsed.error?.message) {
                      const inner = JSON.parse(parsed.error.message);
                      errorMessage = inner.error || parsed.error.message;
                    }
                  }
                } catch (e) {
                  /* If parsing fails, use original errorMessage */
                }

                // SEND EXACT ERROR TO LLM 
                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: JSON.stringify({
                    error: "Tool execution failed",
                    details: errorMessage,
                  }),
                });

                // HANDLE SPECIFIC PERMISSION ERRORS
                if (
                  errorMessage.toLowerCase().includes("access denied") ||
                  errorMessage.toLowerCase().includes("permission")
                ) {
                  messages.push({
                    role: "user",
                    content: `SYSTEM ALERT: The tool execution failed due to an authorization restriction on the user's account (${parsedArgs.userEmail}).

          ERROR DETAILS: "${errorMessage}"
          
          CRITICAL INSTRUCTION FOR YOUR RESPONSE:
          1. Speak directly to the user about THEIR account status.
          2. STOP saying "I don't have permission". instead say "You do not have permission".
          3. Explicitly state: "Your account (${parsedArgs.userEmail}) lacks the necessary permissions to read content in this channel."
          4. Do not retry. Advise them to contact an administrator.`,
                  });
                  break; 
                }
              }
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
3. Organize information logically
4. DO NOT mention tools, functions, or technical processes
5. DO NOT apologize excessively
6. Do not just read out the results from the tool but you need to use the data from the tool result to give an informative response and if they are juust tool call args do not read them out you need to call the tool

Provide your final formatted response now.`,
          });

          // One final attempt to get a response
          const finalResponse = await gateway.run({
            provider: "openai",
            endpoint: "chat/completions",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
            },
            query: {
              model: "gpt-5-nano",
              messages: messages,
              tools: [],
              tool_choice: "none",
              // max_tokens: 1000,
            },
          });

          const finalResult = await finalResponse.json();
          if (finalResult.choices && finalResult.choices[0]?.message?.content) {
            messages.push({
              role: "assistant",
              content: finalResult.choices[0].message.content,
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
