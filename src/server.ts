import {
  Agent,
  type AgentNamespace,
  routeAgentRequest,
  getAgentByName,
} from "agents";

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

        // Check connection state before attempting to use tools
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

        // Fetch tools with retry logic
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
            const displayName = tool.name || toolKey;
            toolExecutorMap[displayName] = tool;
            return {
              type: "function",
              function: {
                name: displayName,
                description: tool.description,
                parameters: tool.inputSchema.jsonSchema,
              },
            };
          },
        );

        const systemPrompt = `You are Paraat AI, a professional production assistant.

### YOUR GOAL:
Analyze technical data and provide a warm, executive summary for the user.

### CRITICAL RULES:
1. NEVER copy-paste tool outputs verbatim. 
2. ALWAYS synthesize the data. Instead of "2026-01-23 - 130 messages", say "Activity peaked on **January 23rd** with 130 messages."
3. FORMATTING: Use ### for headers, bullet points for lists, and **bold** for names/numbers.
4. TONE: Professional, helpful, and concise.
5. NO RAW JSON: If you see IDs or technical brackets, hide them.

### RESPONSE STRUCTURE:
1. A brief "Here is the summary for the [Channel Name] channel..."
2. Key insights (Who is most active? How is the engagement?).
3. A clear "Next Step" suggestion.`;

        let messages: Message[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ];

        let isRunning = true;
        let loopCount = 0;
        const MAX_LOOPS = 5;
        // Safeguard: Track tools to prevent duplicate executions (like double-posting)
        const executedTools = new Set<string>();

        while (isRunning && loopCount < MAX_LOOPS) {
          loopCount++;

          const response = await gateway.run({
            provider: "workers-ai",
            endpoint: "@cf/meta/llama-3.1-70b-instruct",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN || "LOCAL_AUTH_FALLBACK"}`,
            },
            query: {
              messages: messages,
              tools: tools,
              tool_choice: "auto",
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

          // Prepare Assistant Message
          let assistantMessage: Message = {
            role: "assistant",
            content: result.result.response || "",
          };
          if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;

          messages.push(assistantMessage);

          // If no tool calls, the LLM is providing a final text answer
          if (toolCalls.length === 0) {
            isRunning = false;
            break;
          }

          // Process each tool call
          for (const toolCall of toolCalls) {
            const { name, arguments: args, id: callId } = toolCall;

            // PREVENT DUPLICATE TOOL EXECUTION
            if (executedTools.has(name)) {
              console.warn(`[Chat] Blocking duplicate execution of: ${name}`);
              messages.push({
                role: "tool",
                tool_call_id: callId,
                name: name,
                content: JSON.stringify({
                  error: "Action already performed.",
                  instruction:
                    "You have already called this tool. Do not call it again. Please summarize the outcome for the user based on previous data.",
                }),
              });
              continue; // Skip actual execution
            }

            const tool = toolExecutorMap[name];
            if (tool) {
              try {
                let parsedArgs =
                  typeof args === "string" ? JSON.parse(args) : { ...args };

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
                console.log(`[Chat] Executing: ${name}`);
                const toolOutput = await tool.execute(parsedArgs);

                // Mark as executed so it's never called again in this session
                executedTools.add(name);

                let cleanContent =
                  toolOutput.result?.content?.[0]?.text ||
                  (typeof toolOutput === "string"
                    ? toolOutput
                    : JSON.stringify(toolOutput));

                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: cleanContent,
                });
              } catch (e: any) {
                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: JSON.stringify({
                    error: "Tool execution failed",
                    details: e.message,
                  }),
                });
              }
            }
          }
        }

        if (loopCount >= MAX_LOOPS) {
          console.warn(`[Chat] Reached maximum loop count (${MAX_LOOPS})`);
        }

        // Final content extraction: Get the last assistant message that actually has text
        const finalAssistantMessage = messages
          .filter((m) => m.role === "assistant" && m.content && m.content.trim().length > 0)
          .pop();

        return Response.json({
          status: "success",
          answer: finalAssistantMessage?.content || "I've analyzed the data, but I'm having trouble formatting the summary. Please try again.",
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
