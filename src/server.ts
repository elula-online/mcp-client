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

type Message =
  | {
      role: "system" | "user" | "assistant";
      content: string;
      tool_calls?: any[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name: string;
      tool_calls?: never;
    };

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

      // CRITICAL FIX: Clean up ANY non-connected server
      // This includes: failed, error, authenticating, AND unknown states
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

      // Only try to get tools if connection succeeded or is authenticating
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

    // Health check endpoint
    if (url.pathname.endsWith("/health")) {
      try {
        const servers = await this.mcp.listServers();

        // Only count tools from connected servers
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
                name: toolKey, //
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
        const MAX_LOOPS = 3;

        // track tool executions by creating a unique signature: toolName + arguments
        const executedToolSignatures = new Set<string>();
        let hasExecutedAnyTool = false;

        while (isRunning && loopCount < MAX_LOOPS) {
          loopCount++;

          // after executing tools, disable them to force text response
          const shouldAllowTools = !hasExecutedAnyTool;

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
              max_tokens: 800,
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

          // if we have text content, weare done
          if (!shouldAllowTools || toolCalls.length === 0) {
            if (assistantContent && assistantContent.trim().length > 0) {
              messages.push({
                role: "assistant",
                content: assistantContent,
              });
              isRunning = false;
              break;
            } else if (!shouldAllowTools) {
              // we disabled tools but LLM still didnot respond - weforce it
              console.warn("[Chat] LLM failed to respond after tool execution");
              messages.push({
                role: "user",
                content:
                  "Based on the tool results above, please provide a clear, user-friendly summary of what was accomplished. Write as if you're confirming the action to the user.",
              });
              continue;
            }
          }

          // assistant Message with tool calls
          let assistantMessage: Message = {
            role: "assistant",
            content: assistantContent,
          };
          if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
          messages.push(assistantMessage);

          // Process tool calls
          let toolsExecutedThisRound = 0;

          for (const toolCall of toolCalls) {
            const { name, arguments: args, id: callId } = toolCall;

            // Create a unique signature for this specific tool call
            const argsString =
              typeof args === "string" ? args : JSON.stringify(args);
            const toolSignature = `${name}::${argsString}`;

            // PREVENT DUPLICATE TOOL EXECUTION
            if (executedToolSignatures.has(toolSignature)) {
              console.warn(`[Chat] Blocking duplicate: ${name}`);

              continue;
            }

            const tool = toolExecutorMap[name];
            if (tool) {
              try {
                let parsedArgs =
                  typeof args === "string" ? JSON.parse(args) : { ...args };

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

                // Execution
                console.log(`[Chat] Executing: ${name} with args:`, parsedArgs);
                const toolOutput = await tool.execute(parsedArgs);

                // Mark this specific tool call as executed
                executedToolSignatures.add(toolSignature);
                hasExecutedAnyTool = true;
                toolsExecutedThisRound++;

                // Clean and parse the tool output
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

                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: cleanContent,
                });
              } catch (e: any) {
                console.error(`[Chat] Tool execution error:`, e);
                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: JSON.stringify({
                    error: "Tool execution failed",
                    details: e.message,
                  }),
                });
                hasExecutedAnyTool = true;
              }
            } else {
              messages.push({
                role: "tool",
                tool_call_id: callId,
                name: name,
                content: JSON.stringify({
                  error: "Tool not found",
                  details: `Tool ${name} is not available`,
                }),
              });
            }
          }

          // After executing tools, add a specific prompt based on what was executed
          if (toolsExecutedThisRound > 0) {
            // Get the tool results to inform the prompt
            const lastToolResult = messages[messages.length - 1];
            const isSuccessful =
              lastToolResult.content &&
              (lastToolResult.content.includes('"success": true') ||
                lastToolResult.content.includes("success"));

            messages.push({
              role: "user",
              content: `Based on the tool result above, provide a clear summary for the user. 

IMPORTANT RULES:
- Analyze the actual data returned by the tool
- Present the information in a user-friendly format
- Use markdown formatting (headers, lists, bold)
- Do NOT say "I've completed the action" without explaining what the action was
- Do NOT use generic responses like "Request processed"
- Be specific about what data was retrieved or what action was performed
- If data was retrieved (like messages, stats, etc), summarize the key points
- If an action was performed (post, send, create), confirm what specifically was done`,
            });
          }
        }

        if (loopCount >= MAX_LOOPS) {
          console.warn(`[Chat] Reached maximum loop count (${MAX_LOOPS})`);
        }

        // Final content extraction: Get the last assistant message that actually has text
        const finalAssistantMessage = messages
          .filter(
            (m) =>
              m.role === "assistant" &&
              m.content &&
              m.content.trim().length > 0,
          )
          .pop();

        let finalAnswer = finalAssistantMessage?.content || "";

        // If we still don't have a good answer, do ONE more retry with a very specific prompt
        if (
          !finalAnswer ||
          finalAnswer.trim().length === 0 ||
          finalAnswer.startsWith("{") ||
          finalAnswer.length < 20
        ) {
          console.warn(
            "[Chat] Inadequate response, forcing LLM to analyze tool results",
          );

          // Add a very direct instruction
          messages.push({
            role: "user",
            content: `You must provide a proper response now. Look at the tool results in this conversation and explain to the user what information was found or what action was completed. Do not give generic responses. Be specific and helpful.`,
          });

          // One final attempt with tools disabled
          const retryResponse = await gateway.run({
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
              max_tokens: 500,
            },
          });

          const retryResult = await retryResponse.json();
          if (retryResult.success && retryResult.result.response) {
            finalAnswer = retryResult.result.response;
            messages.push({
              role: "assistant",
              content: finalAnswer,
            });
          }
        }

        // Last resort: if STILL no good answer, use tool data directly
        if (
          !finalAnswer ||
          finalAnswer.trim().length < 20 ||
          finalAnswer.startsWith("{")
        ) {
          console.error(
            "[Chat] LLM failed to generate response, extracting from tool data",
          );

          const toolMessages = messages.filter((m) => m.role === "tool");
          if (toolMessages.length > 0) {
            const lastToolMessage = toolMessages[toolMessages.length - 1];

            finalAnswer = `I apologize, I'm having trouble formatting the response properly. Here's the raw data from the tool:\n\n${lastToolMessage.content.substring(0, 500)}...\n\nPlease try rephrasing your request for a better formatted response.`;
          } else {
            finalAnswer =
              "I apologize, but I encountered an issue processing your request. Please try again or rephrase your question.";
          }
        }

        return Response.json({
          status: "success",
          answer: finalAnswer,
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
