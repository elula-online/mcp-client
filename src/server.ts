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
      const result = await this.addMcpServer(
        "SystemPortal",
        portalUrl,
        this.env.HOST,
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
      try {
        const tools = await this.mcp.getAITools();
        toolCount = Object.keys(tools).length;
      } catch (e) {}

      if (result.state === "authenticating" && toolCount === 0) {
        console.warn("[Agent] Auth required:", (result as any).authUrl);
        return;
      }

      console.log(`[Agent] Connected! ID: ${result.id}`);
    } catch (err) {
      console.error("[Agent] Portal Connection Error:", err);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // health check
    if (url.pathname.endsWith("/health")) {
      const servers = await this.mcp.listServers();
      const mcpTools = await this.mcp.getAITools();
      const toolCount = Object.keys(mcpTools).length;
      return Response.json(
        {
          status: toolCount > 0 ? "healthy" : "initializing",
          agent_instance: this.name,
          tools_discovered: toolCount,
          servers: servers.map((s: any) => ({
            name: s.name,
            state: s.state || "unknown",
          })),
          timestamp: new Date().toISOString(),
        },
        { status: toolCount > 0 ? 200 : 503 },
      );
    }

    // tools endpoint
    if (url.pathname.endsWith("/tools")) {
      const tools = await this.mcp.getAITools();
      return Response.json({ status: "success", tools });
    }

    // chat endpoint
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      const { prompt } = (await request.json()) as { prompt: string };

      let attempts = 0;
      let mcpToolsResult = await this.mcp.getAITools();
      
      while (Object.keys(mcpToolsResult).length === 0 && attempts < 5) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        mcpToolsResult = await this.mcp.getAITools();
        attempts++;
      }

      const gateway = this.env.AI.gateway(this.env.GATEWAY_ID);
      const toolExecutorMap: Record<string, any> = {};

      const tools = Object.entries(mcpToolsResult).map(
        ([toolKey, tool]: [string, any]) => {
          const realName = tool.name || toolKey.split("_").slice(2).join("_");
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

      const systemPrompt = `You are a professional production assistant.

CORE GUIDELINES:
1. One-Shot Action: Once you send a message or perform an action, STOP. Do not repeat the same action unless explicitly asked.
2. List Formatting: When asked for a list (e.g., channels), YOU MUST format it as a clean Markdown list with each item on a new line.
   - Correct: 
     Channel A
     Channel B
   - Incorrect: * Channel A * Channel B
3. Response Style: Be concise. Don't show JSON. Just say "I've done X" or "Here is the list:".

ERROR HANDLING:
- If a tool fails, explain why clearly.`;

      let messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ];

      let isRunning = true;
      let loopCount = 0;
      const MAX_LOOPS = 5;

      const executedActions = new Set<string>();

    while (isRunning && loopCount < MAX_LOOPS) {
        loopCount++;

        const response = await gateway.run({
          provider: "workers-ai",
          endpoint: "@cf/meta/llama-3.1-70b-instruct",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
          },
          query: {
            messages: messages,
            tools: tools,
            tool_choice: "auto",
          },
        });

        const result = await response.json();
        if (!result.success) return Response.json({ error: "Gateway Error", details: result }, { status: 500 });

        let assistantMessage: Message;
        if (result.result.response) {
          assistantMessage = { role: "assistant", content: result.result.response };
        } else {
          assistantMessage = { role: "assistant", content: "" };
        }

        if (result.result.tool_calls) {
          assistantMessage.tool_calls = result.result.tool_calls;
        }

        // --- CHECK FOR REPETITION BEFORE PUSHING ---
        if (result.result.tool_calls && result.result.tool_calls.length > 0) {
            const firstCall = result.result.tool_calls[0];
            const actionSignature = `${firstCall.name}:${JSON.stringify(firstCall.arguments)}`;
            
            if (executedActions.has(actionSignature)) {
                console.log(`[Agent] Duplicate detected: ${actionSignature}. Moving to summary.`);
                isRunning = false;
                break; // Exit BEFORE pushing the empty assistant message
            }
        }

        messages.push(assistantMessage);

        if (result.result.tool_calls && result.result.tool_calls.length > 0) {
          for (const toolCall of result.result.tool_calls) {
            const { name, arguments: args } = toolCall;
            const actionSignature = `${name}:${JSON.stringify(args)}`;
            
            executedActions.add(actionSignature);

            let parsedArgs = typeof args === "string" ? JSON.parse(args) : args;
            const tool = toolExecutorMap[name];
            if (tool) {
              try {
                const toolOutput = await tool.execute(parsedArgs);
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: name,
                  content: JSON.stringify(toolOutput),
                });
              } catch (e: any) {
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: name,
                  content: JSON.stringify({ error: "Tool Error", detail: e.message }),
                });
              }
            }
          }
        } else {
          isRunning = false;
        }
      }

      // If the loop ended but the last message was a TOOL result, the user will see JSON.
      // We must force one last "Assistant" turn to summarize the tool result.
     const lastMessage = messages[messages.length - 1];
      
      // If we ended on a tool result, OR an empty assistant message (from a break), force a summary
      if (lastMessage.role === "tool" || (lastMessage.role === "assistant" && !lastMessage.content)) {
          console.log("[Agent] Finalizing response for user...");
          const summaryResponse = await gateway.run({
            provider: "workers-ai",
            endpoint: "@cf/meta/llama-3.1-70b-instruct",
            headers: {
                "Content-Type": "application/json",
                authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
            },
            query: {
                messages: messages,
                tools: [], // Force no more tool calls
            },
          });
          const summaryJson = await summaryResponse.json();
          return Response.json({
              status: "success",
              answer: summaryJson.result?.response || "Task completed successfully."
          });
      }

      return Response.json({
        status: "success",
        answer: lastMessage.content,
      });
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
