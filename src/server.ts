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
  | { role: "tool"; content: string; tool_call_id: string; name: string };

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
      const tools = Object.entries(mcpToolsResult).map(
        ([_, tool]: [any, any]) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })
      );

      // initialize message history
      let messages: Message[] = [{ role: "user", content: prompt }];
      let isRunning = true;
      let loopCount = 0;
      const MAX_LOOPS = 5;

      console.log("Token: ", this.env.CLOUDFLARE_API_TOKEN);

      while (isRunning && loopCount < MAX_LOOPS) {
        loopCount++;

        // run inference via AI Gateway Universal Endpoint (Workers AI provider)
        const response = await gateway.run({
          provider: "workers-ai",
          endpoint: "@cf/meta/llama-3.1-70b-instruct", // using a strong CF model
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

        // handle potential gateway/model errors
        if (!result.choices || result.choices.length === 0) {
          console.error(
            "[Agent Error] Unexpected Gateway Response:",
            JSON.stringify(result, null, 2)
          );
          // return the error to the client instead of throwing generic error
          return Response.json(
            {
              error: "Invalid response from AI Gateway",
              details: result,
            },
            { status: 500 }
          );
        }

        const message = result.choices[0].message;
        messages.push(message);

        // check if the model wants to use a tool
        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const toolCall of message.tool_calls) {
            const { name, arguments: args } = toolCall.function;
            const parsedArgs =
              typeof args === "string" ? JSON.parse(args) : args;

            // execute the tool call via MCP
            const toolOutput = await this.mcp.callTool(name, parsedArgs);

            // add the tool result to history so the LLM can see it in the next turn
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: name,
              content: JSON.stringify(toolOutput),
            });
          }
        } else {
          // no more tool calls, we have our final answer
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
