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
    const MAX_LOOPS = 10; // Increased to allow for sequential tool calls

    // Track tool executions with detailed metadata
    const toolExecutionHistory = new Map<string, ToolExecution>();
    const successfulToolCalls = new Set<string>(); // Track successful calls to prevent re-execution

     //analyze tool error to determine recovery strategy
    function analyzeToolError(
      toolName: string,
      errorContent: string,
      toolArgs: any
    ): {
      errorType: "not_found" | "invalid_params" | "missing_id" | "other";
      suggestedRecovery?: string;
      missingParam?: string;
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
          };
        }
        if (errorLower.includes("user") && !toolArgs.user_id) {
          return {
            errorType: "not_found",
            suggestedRecovery: "mattermost_get_users",
            missingParam: "user_id",
          };
        }
        if (errorLower.includes("post") || errorLower.includes("thread")) {
          return {
            errorType: "not_found",
            suggestedRecovery: "mattermost_search_messages",
            missingParam: "post_id",
          };
        }
        return { errorType: "not_found" };
      }

      // Check for invalid parameter errors
      if (
        errorLower.includes("invalid") ||
        errorLower.includes("bad request") ||
        errorLower.includes("400")
      ) {
        return { errorType: "invalid_params" };
      }

      return { errorType: "other" };
    }

    //create smart guidance prompt for LLM after tool error
    function createErrorRecoveryPrompt(
      toolName: string,
      errorAnalysis: ReturnType<typeof analyzeToolError>,
      originalArgs: any,
      hasSearchedAlready: boolean = false
    ): string {
      if (errorAnalysis.suggestedRecovery) {
        const examples: Record<string, string> = {
          mattermost_search_channels: hasSearchedAlready 
            ? `You already searched for channels. Now you MUST:
1. Look at the PREVIOUS mattermost_search_channels result in this conversation
2. Find the channel with name matching "${originalArgs.channel}"
3. Extract the "id" field from that channel object
4. Call ${toolName} using the extracted channel ID (use parameter "channel" with the ID value)

CRITICAL: Do NOT search again. Use the ID from the previous search result.`
            : `The channel was not found using the name "${originalArgs.channel}". 
          
You should:
1. Call mattermost_search_channels with search_term: "${originalArgs.channel}"
2. Look through the results to find the matching channel
3. Extract the "id" field from the matching channel
4. Retry ${toolName} with channel: "<extracted_id>"`,

          mattermost_get_users: hasSearchedAlready
            ? `You already searched for users. Now you MUST:
1. Look at the PREVIOUS mattermost_get_users result
2. Find the user matching "${originalArgs.username || originalArgs.user_id}"
3. Extract the "id" field from that user object
4. Call ${toolName} using the extracted user_id

CRITICAL: Do NOT search again. Use the ID from the previous search result.`
            : `The user was not found using "${originalArgs.username || originalArgs.user_id}".

You should:
1. Call mattermost_get_users to get all users
2. Search for a user matching "${originalArgs.username || originalArgs.user_id}"
3. Extract the user_id from the result
4. Retry ${toolName} with the correct user_id`,

          mattermost_search_messages: `The post/thread was not found.

You should:
1. Call mattermost_search_messages or mattermost_search_threads to find the conversation
2. Extract the post_id from the results
3. Retry ${toolName} with the correct post_id`,
        };

        return examples[errorAnalysis.suggestedRecovery] || "An error occurred. Please analyze the error and determine the next step.";
      }

      return `The tool ${toolName} failed. Analyze the error and determine if you need to call another tool first to get the required information, or if you should inform the user about the issue.`;
    }

    // main agent loop
    let consecutiveFailedAttempts = 0;
    let lastFailedToolName = "";
    
    while (isRunning && loopCount < MAX_LOOPS) {
      loopCount++;
      console.log(`[Agent] Loop ${loopCount}/${MAX_LOOPS}`);

      // allow tools until we get a final answer
      const shouldAllowTools = true;

      const response = await gateway.run({
        provider: "workers-ai",
        endpoint: "@cf/meta/llama-3.1-70b-instruct",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN || "LOCAL_AUTH_FALLBACK"}`,
        },
        query: {
          messages: messages,
          tools: shouldAllowTools ? tools : [],
          tool_choice: shouldAllowTools ? "auto" : "none",
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

      // if LLM provides a text response with no tool calls, we're done
      if (toolCalls.length === 0 && assistantContent && assistantContent.trim().length > 0) {
        messages.push({
          role: "assistant",
          content: assistantContent,
        });
        isRunning = false;
        break;
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
        let onlySearchToolsCalled = toolCalls.every((tc: ToolCall) => 
          tc.name.includes('search') || 
          tc.name.includes('list') || 
          tc.name.includes('get_users') ||
          tc.name.includes('get_channels')
        );

        // Process each tool call
        for (const toolCall of toolCalls) {
          const { name, arguments: args, id: callId } = toolCall;

          // Create unique signature for this tool call
          const argsString = typeof args === "string" ? args : JSON.stringify(args);
          const toolSignature = `${name}::${argsString}`;

          // CONSTRAINT 1: Prevent calling a tool that already succeeded
          if (successfulToolCalls.has(toolSignature)) {
            console.warn(`[Agent] Blocking duplicate successful call: ${name}`);
            messages.push({
              role: "tool",
              tool_call_id: callId,
              name: name,
              content: JSON.stringify({
                error: "This exact tool call was already executed successfully. Use the previous result instead of calling again.",
                previous_result: toolExecutionHistory.get(toolSignature)?.result,
              }),
            });
            continue;
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
            let parsedArgs = typeof args === "string" ? JSON.parse(args) : { ...args };

            // Convert string numbers to actual numbers
            for (const key in parsedArgs) {
              const value = parsedArgs[key];
              if (
                typeof value === "string" &&
                value.trim() !== "" &&
                !isNaN(Number(value))
              ) {
                parsedArgs[key] = Number(value);
              }
            }

            // Execute the tool
            console.log(`[Agent] Executing: ${name} with args:`, parsedArgs);
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
            const isSuccess = !cleanContent.toLowerCase().includes('"error"') &&
                            !cleanContent.toLowerCase().includes('"success": false') &&
                            !cleanContent.toLowerCase().includes('404') &&
                            !cleanContent.toLowerCase().includes('not found');

            if (isSuccess) {
              // Mark as successful to prevent re-execution
              successfulToolCalls.add(toolSignature);
              toolExecutionHistory.set(toolSignature, {
                signature: toolSignature,
                result: cleanContent,
                success: true,
              });

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
              
            } else {
              // CONSTRAINT 2: Tool failed - analyze error and provide recovery guidance
              const errorAnalysis = analyzeToolError(name, cleanContent, parsedArgs);
              
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

              // If we've failed 3 times on the same tool, force the agent to respond
              if (consecutiveFailedAttempts >= 3) {
                console.warn(`[Agent] Tool ${name} failed ${consecutiveFailedAttempts} times. Forcing final response.`);
                messages.push({
                  role: "user",
                  content: `You have attempted to use ${name} multiple times without success. Based on all the information you've gathered so far, please provide a helpful response to the user explaining what you found (if anything) or what the issue might be. Do not attempt to use ${name} again.`,
                });
                consecutiveFailedAttempts = 0; // Reset to prevent repeated triggers
              } else {
                // Check if we've already called the recovery tool successfully
                const hasCalledRecoveryTool = errorAnalysis.suggestedRecovery 
                  ? Array.from(successfulToolCalls).some(sig => sig.startsWith(errorAnalysis.suggestedRecovery + "::"))
                  : false;

                // Add intelligent recovery guidance
                const recoveryPrompt = createErrorRecoveryPrompt(
                  name, 
                  errorAnalysis, 
                  parsedArgs,
                  hasCalledRecoveryTool
                );
                
                messages.push({
                  role: "user",
                  content: recoveryPrompt,
                });

                console.log(`[Agent] ✗ Tool ${name} failed with ${errorAnalysis.errorType}. ${hasCalledRecoveryTool ? 'Recovery tool already called - instructing to use results' : 'Suggesting recovery'}.`);
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

            // Provide recovery guidance for exceptions too
            messages.push({
              role: "user",
              content: `The tool ${name} threw an exception: ${e.message}. Please analyze if you need different parameters or a different tool to accomplish the task.`,
            });
          }
        }
        
        // If we're at loop 5+ and only search tools were called, intervene
        if (loopCount >= 5 && onlySearchToolsCalled && successfulToolCalls.size > 0) {
          console.warn(`[Agent] Loop ${loopCount}: Only search tools called. Forcing LLM to use results.`);
          messages.push({
            role: "user",
            content: `IMPORTANT: You have successfully gathered information using search tools. Now you MUST use that information to answer the user's original question. 

Look back at the tool results in this conversation and:
1. Extract any IDs, names, or data from successful tool calls
2. Use those values to call the action tools (like mattermost_summarize_channel, mattermost_post_message, etc.)
3. DO NOT call any more search tools - you already have the information you need

If the search results show a channel/user/post exists, use its ID to complete the action.`
          });
        }
      } else {
        // No tool calls and no text content - prompt LLM to respond
        console.warn("[Agent] LLM provided neither tool calls nor text response");
        messages.push({
          role: "user",
          content: "Please provide a response based on the information available or explain what additional information you need.",
        });
      }
    }

    if (loopCount >= MAX_LOOPS) {
      console.warn(`[Agent] Reached maximum loop count (${MAX_LOOPS})`);
      messages.push({
        role: "user",
        content: "Please provide a final summary based on all the information gathered so far.",
      });

      // One final attempt to get a response
      const finalResponse = await gateway.run({
        provider: "workers-ai",
        endpoint: "@cf/meta/llama-3.1-70b-instruct",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN || "LOCAL_AUTH_FALLBACK"}`,
        },
        query: {
          messages: messages,
          tools: [],
          tool_choice: "none",
          max_tokens: 800,
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
          m.content.trim().length > 0
      )
      .pop();

    let finalAnswer = finalAssistantMessage?.content || "I apologize, but I was unable to complete your request. Please try rephrasing or provide more details.";

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
