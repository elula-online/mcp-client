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
    const result = await this.addMcpServer(
      "SystemPortal",
      portalUrl,
      this.env.HOST,
      undefined, 
      {
        transport: {
          type: "sse",
          headers: {
            "Authorization": `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
            "X-Account-ID": this.env.ACCOUNT_ID,
            "X-Gateway-ID": this.env.GATEWAY_ID,
          },
        },
      }
    );

    if (result.state === "authenticating") {
      console.warn("[Agent] Automatic auth failed. Manual action still required:", result.authUrl);
      return;
    }

    // result.state is now "ready"
    console.log(`[Agent] Connected! ID: ${result.id}`);
    
    const tools = await this.mcp.getAITools();
    console.log(`[Agent] Success! Found tools: ${Object.keys(tools).length}`);
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
   
          const realName = tool.name || toolKey.split("_").slice(2).join("_");

          // store the whole tool object (which has the .execute function)
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
          // if the gateway returned a message history, take the last one
          assistantMessage = { ...result.messages[result.messages.length - 1] };
        } else {
          // create a clean assistant message object
          assistantMessage = { role: "assistant", content: "" };
        }

        // attach tool_calls if they exist
        if (result.result.tool_calls) {
          assistantMessage.tool_calls = result.result.tool_calls;
        }

        messages.push(assistantMessage);

        console.log("assistantMessage: ", assistantMessage);

       
        if (result.result.tool_calls && result.result.tool_calls.length > 0) {
          for (const toolCall of result.result.tool_calls) {
            const { name, arguments: args } = toolCall;
            let parsedArgs = typeof args === "string" ? JSON.parse(args) : args;

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
          
        } else {
          
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
