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
      const existingServers = await this.mcp.listServers();
      const workingServer = existingServers.find(
        (s: any) => s.name === "SystemMCPportal" && s.state === "connected"
      );

      if (workingServer) {
        console.log(`[Agent] Already connected: ${workingServer.id}`);
        return;
      }

      for (const server of existingServers) {
        if (server.state !== "connected") {
          await this.mcp.removeServer(server.id).catch(() => {});
        }
      }

      console.log(`[Agent] Connecting to MCP Portal...`);

const result = await this.addMcpServer(
  "SystemMCPportal",
  this.env.MCP_PORTAL_URL,     // https://mcp.elula.cloud/mcp
  this.env.MCP_PORTAL_URL,     // ✅ Audience should ALSO be the portal URL
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

      if (result.state !== "connected") {
        console.error(`[Agent] Connection failed: ${result.state}`);
        await this.mcp.removeServer(result.id).catch(() => {});
        return;
      }

      const tools = await this.mcp.getAITools();
      console.log(`[Agent] Connected. Tools: ${Object.keys(tools).length}`);

    } catch (err) {
      console.error("[Agent] Portal connection error:", err);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/health")) {
      const servers = await this.mcp.listServers();
      const tools = await this.mcp.getAITools();

      return Response.json({
        status: Object.keys(tools).length ? "healthy" : "initializing",
        connected_servers: servers.filter((s:any)=>s.state==="connected").length,
        tools: Object.keys(tools).length,
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname.endsWith("/tools")) {
      return Response.json({
        status: "ok",
        tools: await this.mcp.getAITools(),
      });
    }

    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      const { prompt } = await request.json() as { prompt: string };

      const toolsResult = await this.mcp.getAITools();
      if (!Object.keys(toolsResult).length) {
        return Response.json(
          { error: "No MCP tools available" },
          { status: 503 }
        );
      }

      const gateway = this.env.AI.gateway(this.env.GATEWAY_ID);
      const toolExecutorMap: Record<string, any> = {};

      const tools = Object.entries(toolsResult).map(([k, tool]: any) => {
        toolExecutorMap[tool.name] = tool;
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema.jsonSchema,
          },
        };
      });

      let messages: Message[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt },
      ];

      const response = await gateway.run({
        provider: "workers-ai",
        endpoint: "@cf/meta/llama-3.1-70b-instruct",
        headers: {
          authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
        },
        query: { messages, tools, tool_choice: "auto" },
      });

      const result = await response.json();
      if (!result.success)
        return Response.json({ error: "Gateway error" }, { status: 500 });

      return Response.json({
        status: "success",
        answer: result.result.response,
      });
    }

    return new Response(`Agent "${this.name}" active.`);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const agent = await getAgentByName(env.MyAgent, "default");
    return agent.fetch(request);
  },
} satisfies ExportedHandler<Env>;
