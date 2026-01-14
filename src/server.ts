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
      const { id, authUrl } = await this.addMcpServer(
        "SystemPortal",
        portalUrl,
        this.env.HOST
      );

      if (authUrl) {
        console.log(
          "---------------------------------------------------------"
        );
        console.log("ACTION REQUIRED: You need to authorize this connection.");
        console.log("Open this URL in your browser to log in:");
        console.log(authUrl);
        console.log(
          "---------------------------------------------------------"
        );
        return;
      }

      const tools: any = await this.mcp.getAITools();
      console.log(`[Agent] Success! Found tools: ${JSON.stringify(tools)}`);
    } catch (err) {
      console.error("[Agent] Portal Connection Error:", err);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/tools")) {
      const tools = await this.mcp.getAITools();
      return Response.json({ status: "success", tools });
    }

    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      const { prompt } = (await request.json()) as { prompt: string };
      const gateway = this.env.AI.gateway(this.env.GATEWAY_ID);

      // fetch and format MCP tools for Cloudflare Workers AI
      const mcpToolsResult = await this.mcp.getAITools();

      const toolExecutorMap: Record<string, any> = {};

      const tools = Object.entries(mcpToolsResult).map(
        ([toolKey, tool]: [string, any]) => {
          // Clean name for the LLM
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
        }
      );

      // initialize message history
      let messages: Message[] = [{ role: "user", content: prompt }];
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
        if (!result.success)
          return Response.json(
            { error: "Gateway Error", details: result },
            { status: 500 }
          );

        console.log("result: ", result);

        let assistantMessage: Message;

        if (result.result.response) {
          // If there's a text response, use it
          assistantMessage = {
            role: "assistant",
            content: result.result.response,
          };
        } else if (result.messages && result.messages.length > 0) {
          // If the gateway returned a message history, take the last one
          assistantMessage = { ...result.messages[result.messages.length - 1] };
        } else {
          // FALLBACK: Create a clean assistant message object
          // This prevents "Cannot set properties of undefined"
          assistantMessage = { role: "assistant", content: "" };
        }

        // Now safely attach tool_calls if they exist
        if (result.result.tool_calls) {
          assistantMessage.tool_calls = result.result.tool_calls;
        }

        messages.push(assistantMessage);

        console.log("assistantMessage: ", assistantMessage);

        // 2. CHECK FOR TOOL CALLS
        if (result.result.tool_calls && result.result.tool_calls.length > 0) {
          for (const toolCall of result.result.tool_calls) {
            const { name, arguments: args } = toolCall;
            let parsedArgs = typeof args === "string" ? JSON.parse(args) : args;

            // Data Type Sanitization
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
                const toolOutput = await tool.execute(parsedArgs);
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: name,
                  content: JSON.stringify(toolOutput),
                });
              } catch (e: any) {
                // By pushing this error as a "tool" result, the LLM will see it
                // and in the NEXT loop iteration, it will explain the 403 to you.
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  name: name,
                  content: JSON.stringify({
                    error:
                      "Access Denied (403). The Mattermost server is blocking this request via Cloudflare WAF.",
                    raw_detail: e.message,
                  }),
                });
              }
            }
          }
          // The loop continues, and the LLM will now "see" the 403 error in the history
        } else {
          // No tool calls means the LLM has given its final reasoned answer
          isRunning = false;
        }
      }

      return Response.json({
        status: "success",
        answer: messages[messages.length - 1].content,
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
