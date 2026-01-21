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
  MCP_SERVER_URL: string;
  ACCOUNT_ID: string;
  GATEWAY_ID: string;
  AI: any;
  CLOUDFLARE_API_TOKEN: string;
  CFAccessClientId: string;
  CFAccessClientSecret: string;
  
  // OAuth tokens for MCP Portal
  MCP_ACCESS_TOKEN?: string;
  MCP_REFRESH_TOKEN?: string;
  MCP_CLIENT_ID?: string;
  MCP_CLIENT_SECRET?: string;
  
  // KV namespace for storing tokens
  MCP_TOKENS?: KVNamespace;
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
  
  // Helper method to get access token (with refresh if needed)
  private async getAccessToken(): Promise<string | null> {
    // Option 1: From environment variable (manually set after OAuth)
    if (this.env.MCP_ACCESS_TOKEN) {
      return this.env.MCP_ACCESS_TOKEN;
    }
    
    // Option 2: From KV storage (if you store tokens there)
    if (this.env.MCP_TOKENS) {
      const tokenData = await this.env.MCP_TOKENS.get('mcp_tokens', 'json') as any;
      if (tokenData?.access_token) {
        // Check if token is expired
        const expiresAt = tokenData.expires_at || 0;
        if (Date.now() < expiresAt) {
          return tokenData.access_token;
        }
        
        // Try to refresh token
        if (tokenData.refresh_token && this.env.MCP_CLIENT_ID && this.env.MCP_CLIENT_SECRET) {
          const newToken = await this.refreshAccessToken(tokenData.refresh_token);
          if (newToken) {
            return newToken;
          }
        }
      }
    }
    
    return null;
  }
  
  // Helper method to refresh access token
  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    try {
      const tokenEndpoint = new URL('/token', this.env.MCP_PORTAL_URL).toString();
      
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.env.MCP_CLIENT_ID || '',
          client_secret: this.env.MCP_CLIENT_SECRET || '',
        }),
      });
      
      if (!response.ok) {
        console.error('[Agent] Token refresh failed:', await response.text());
        return null;
      }
      
      const data = await response.json() as any;
      
      // Store new tokens in KV
      if (this.env.MCP_TOKENS && data.access_token) {
        await this.env.MCP_TOKENS.put('mcp_tokens', JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token || refreshToken,
          expires_at: Date.now() + (data.expires_in * 1000),
        }));
      }
      
      return data.access_token;
    } catch (error) {
      console.error('[Agent] Token refresh error:', error);
      return null;
    }
  }

  async onStart() {
    const portalUrl = this.env.MCP_PORTAL_URL;

    try {
      // Check if we already have a working connection
      const existingServers = await this.mcp.listServers();
      const workingServer = existingServers.find(
        (s: any) => s.name === "SystemMCPportal" && s.state === "connected"
      );
      
      if (workingServer) {
        console.log(`[Agent] Already connected to portal: ${workingServer.id}`);
        
        // Verify tools are available
        try {
          const tools = await this.mcp.getAITools();
          const toolCount = Object.keys(tools).length;
          console.log(`[Agent] Existing connection has ${toolCount} tools available`);
          return;
        } catch (e) {
          console.warn(`[Agent] Existing connection has no tools, will reconnect`);
        }
      }
      
      // Clean up any non-connected servers
      let cleanedCount = 0;
      for (const server of existingServers) {
        if (server.state !== "connected") {
          console.log(`[Agent] Cleaning up ${server.state} connection: ${server.name} (${server.id})`);
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

      // Build headers with authentication
      const headers: Record<string, string> = {
        "CF-Access-Client-Id": this.env.CFAccessClientId,
        "CF-Access-Client-Secret": this.env.CFAccessClientSecret,
      };
      
      // Add OAuth token if available
      const accessToken = await this.getAccessToken();
      if (accessToken) {
        headers["Authorization"] = `Bearer ${accessToken}`;
        console.log("[Agent] Using OAuth access token for authentication");
      } else {
        console.warn("[Agent] No OAuth token available - connection may require manual authentication");
      }

      const result = await this.addMcpServer(
        "SystemMCPportal",
        portalUrl,
        this.env.MCP_SERVER_URL,
        undefined,
        {
          transport: {
            type: "streamable-http",
            headers: headers,
          },
        },
      );

      let toolCount = 0;

      // Handle different connection states
      if (result.state === "connected") {
        try {
          const tools = await this.mcp.getAITools();
          toolCount = Object.keys(tools).length;
          console.log(`[Agent] Connected! Found ${toolCount} tools`);
        } catch (e) {
          console.error("[Agent] Error fetching tools:", e);
        }
      } else if (result.state === "authenticating") {
        const authUrl = (result as any).authUrl;
        console.error(`[Agent] ⚠️  AUTHENTICATION REQUIRED ⚠️`);
        console.error(`[Agent] Please visit this URL to authorize:`);
        console.error(`[Agent] ${authUrl}`);
        console.error(`[Agent] After authorization, extract the tokens and set them as environment variables:`);
        console.error(`[Agent] - MCP_ACCESS_TOKEN`);
        console.error(`[Agent] - MCP_REFRESH_TOKEN (optional, for auto-refresh)`);
        
        // Clean up the authenticating connection
        try {
          await this.mcp.removeServer(result.id);
        } catch (e) {
          console.warn(`[Agent] Could not remove authenticating connection:`, e);
        }
        return;
      } else if (result.state === "failed" || result.state === "error") {
        console.error(`[Agent] Connection failed with state: ${result.state}`);
        try {
          await this.mcp.removeServer(result.id);
          console.log(`[Agent] Removed failed connection: ${result.id}`);
        } catch (e) {
          console.warn(`[Agent] Could not remove failed connection:`, e);
        }
        return;
      }

      console.log(`[Agent] Connected! ID: ${result.id}, State: ${result.state}`);
      console.log(`[Agent] Success! Found tools: ${toolCount}`);
    } catch (err) {
      console.error("[Agent] Portal Connection Error:", err);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // OAuth callback endpoint - handle token exchange
    if (url.pathname.endsWith("/oauth/callback")) {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      
      if (!code) {
        return Response.json({ error: "No authorization code received" }, { status: 400 });
      }
      
      console.log(`[OAuth] Received authorization code, exchanging for tokens...`);
      
      // This is just for logging - actual token exchange would happen here
      // You'd need to implement the full OAuth flow with PKCE
      return Response.json({
        message: "Authorization code received. Please extract tokens from the MCP Portal response and set as environment variables.",
        code: code,
        state: state,
      });
    }

    // Health check endpoint
    if (url.pathname.endsWith("/health")) {
      try {
        const servers = await this.mcp.listServers();
        const connectedServers = servers.filter((s: any) => s.state === "connected");
        
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
          has_oauth_token: !!this.env.MCP_ACCESS_TOKEN,
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
          { status: 500 }
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
            error: error instanceof Error ? error.message : String(error)
          },
          { status: 500 }
        );
      }
    }

    // Chat endpoint
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      try {
        const { prompt } = (await request.json()) as { prompt: string };

        // Check connection state before attempting to use tools
        const servers = await this.mcp.listServers();
        const connectedServers = servers.filter((s: any) => s.state === "connected");
        
        if (connectedServers.length === 0) {
          console.warn("[Chat] No connected MCP servers available");
          
          // Try to reconnect
          await this.onStart();
          
          // Check again
          const serversAfterReconnect = await this.mcp.listServers();
          const reconnectedServers = serversAfterReconnect.filter((s: any) => s.state === "connected");
          
          if (reconnectedServers.length === 0) {
            return Response.json(
              {
                error: "No connected MCP servers available",
                suggestion: "The MCP portal may require authentication. Check the logs for the authorization URL.",
              },
              { status: 503 }
            );
          }
        }

        // Fetch tools with retry logic
        let attempts = 0;
        const MAX_ATTEMPTS = 5;
        let mcpToolsResult: Record<string, any> = {};

        while (Object.keys(mcpToolsResult).length === 0 && attempts < MAX_ATTEMPTS) {
          try {
            mcpToolsResult = await this.mcp.getAITools();
            
            if (Object.keys(mcpToolsResult).length === 0 && attempts < MAX_ATTEMPTS - 1) {
              console.log(
                `[Chat] Waiting for MCP tool discovery... attempt ${attempts + 1}/${MAX_ATTEMPTS}`,
              );
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          } catch (error) {
            console.error(`[Chat] Error fetching tools (attempt ${attempts + 1}):`, error);
            if (attempts < MAX_ATTEMPTS - 1) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
          
          attempts++;
        }

        if (Object.keys(mcpToolsResult).length === 0) {
          return Response.json(
            {
              error: "No MCP tools available after retry",
              attempts: attempts,
              suggestion: "The MCP server may not have any tools configured or is still initializing.",
            },
            { status: 503 }
          );
        }

        const gateway = this.env.AI.gateway(this.env.GATEWAY_ID);

        // Prepare tools for Cloudflare Workers AI
        const toolExecutorMap: Record<string, any> = {};

        const tools = Object.entries(mcpToolsResult).map(
          ([toolKey, tool]: [string, any]) => {
            const realName = tool.name || toolKey.split("_").slice(2).join("_");

            // Store the whole tool object (which has the .execute function)
            toolExecutorMap[realName] = tool;

            return {
              type: "function",

              function: {
                name: realName,
                description: tool.description,
                parameters: tool.inputSchema.jsonSchema,
              },
            };
          },
        );

        // Initialize message history
        const systemPrompt = `You are a professional production assistant.

### CORE GUIDELINES:

1. **Tool Usage:** Use tools ONLY when necessary. If general knowledge suffices, use that.

2. **Capability Boundaries:** If a request requires data/tools you don't have, state that you don't have access to that specific functionality.

3. **Formatting:** ALWAYS respond with well-formatted, clean, and readable Markdown. Use lists, bold text, and headers where appropriate.

### TOOL DATA PROCESSING:

- NEVER output raw JSON or technical strings (like "{\\"success\\": true...}") to the user.

- Your job is to extract the relevant information from tool results and present it in a helpful, conversational summary.

- Example: If a tool returns a 'post_id' and a 'message', don't show the IDs; just say: "I've successfully sent your message: 'Good day' to the channel."

### ERROR HANDLING:

- If a tool fails (e.g., 403 error), explain clearly that a firewall or permission restriction blocked the action.`;

        let messages: Message[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ];

        let isRunning = true;
        let loopCount = 0;
        const MAX_LOOPS = 5;

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
            console.error("[Chat] Gateway error:", result);
            return Response.json(
              { error: "Gateway Error", details: result },
              { status: 500 },
            );
          }

          console.log(`[Chat] Loop ${loopCount} result:`, result);

          let assistantMessage: Message;

          if (result.result.response) {
            // If there is a text response, use it
            assistantMessage = {
              role: "assistant",
              content: result.result.response,
            };
          } else if (result.messages && result.messages.length > 0) {
            // If the gateway returned a message history, take the last one
            assistantMessage = { ...result.messages[result.messages.length - 1] };
          } else {
            // Create a clean assistant message object
            assistantMessage = { role: "assistant", content: "" };
          }

          // Attach tool_calls if they exist
          if (result.result.tool_calls) {
            assistantMessage.tool_calls = result.result.tool_calls;
          }

          messages.push(assistantMessage);

          console.log(`[Chat] Assistant message:`, assistantMessage);

          if (result.result.tool_calls && result.result.tool_calls.length > 0) {
            for (const toolCall of result.result.tool_calls) {
              const { name, arguments: args } = toolCall;

              let parsedArgs = typeof args === "string" ? JSON.parse(args) : args;

              // Convert numeric strings to numbers
              for (const key in parsedArgs) {
                const val = parsedArgs[key];

                if (
                  typeof val === "string" &&
                  !isNaN(Number(val)) &&
                  val.trim() !== ""
                ) {
                  parsedArgs[key] = Number(val);
                }
              }

              const tool = toolExecutorMap[name];

              if (tool) {
                try {
                  console.log(`[Chat] Executing tool: ${name} with args:`, parsedArgs);
                  const toolOutput = await tool.execute(parsedArgs);

                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: name,
                    content: JSON.stringify(toolOutput),
                  });
                } catch (e: any) {
                  console.error(`[Chat] Tool execution error for ${name}:`, e);
                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: name,
                    content: JSON.stringify({
                      error: "Tool execution failed",
                      raw_detail: e.message,
                    }),
                  });
                }
              } else {
                console.warn(`[Chat] Tool not found: ${name}`);
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: name,
                  content: JSON.stringify({
                    error: "Tool not found",
                    available_tools: Object.keys(toolExecutorMap),
                  }),
                });
              }
            }
          } else {
            isRunning = false;
          }
        }

        if (loopCount >= MAX_LOOPS) {
          console.warn(`[Chat] Reached maximum loop count (${MAX_LOOPS})`);
        }

        return Response.json({
          status: "success",
          answer: messages[messages.length - 1].content,
        });
      } catch (error) {
        console.error("[Chat] Unexpected error:", error);
        return Response.json(
          {
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
          },
          { status: 500 }
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
