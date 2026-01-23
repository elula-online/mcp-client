import {
  Agent,
  type AgentNamespace,
  routeAgentRequest,
  getAgentByName,
} from "agents";

type Env = {
  MyAgent: AgentNamespace<MyAgent>;
  HOST: string;
  MCP_SERVERS_JSON: string;
};

export class MyAgent extends Agent<Env, never> {
  // Called once per worker instance
  async onStart() {
    // Parse JSON config for backend MCP servers
    let servers: string[] = [];

    try {
      servers = JSON.parse(this.env.MCP_SERVERS_JSON || "[]") as string[];
    } catch (err: unknown) {
      console.error(
        "[Gateway] Failed to parse MCP_SERVERS_JSON:",
        err instanceof Error ? err.message : String(err)
      );
      servers = [];
    }

    for (const serverUrl of servers) {
      const existing = await this.mcp.listServers();

      // Skip if already connected
      if (
        existing.some(
          (s: any) => (s as any).serverUrl === serverUrl && s.state === "connected"
        )
      ) {
        continue;
      }

      try {
        const result = await this.addMcpServer(
          serverUrl,
          serverUrl,
          this.env.HOST,
          undefined,
          {
            transport: {
              type: "polling-http",
              interval: 3000,
            },
          }
        );

        console.log(
          `[Gateway] Connected to MCP server: ${serverUrl} state=${result.state}`
        );
      } catch (e: unknown) {
        console.error(
          `[Gateway] Failed to add MCP server: ${serverUrl}`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }

    try {
      const allTools = await this.mcp.getAITools();
      console.log("[Gateway] Tools discovered:", Object.keys(allTools));
    } catch (e: unknown) {
      console.warn(
        "[Gateway] Tools discovery failed:",
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return this.handleMcpProxy(request);
    }

    if (url.pathname === "/health") {
      const servers = await this.mcp.listServers();
      let toolsCount = 0;
      try {
        const tools = await this.mcp.getAITools();
        toolsCount = Object.keys(tools).length;
      } catch {}

      return Response.json({ servers, toolCount: toolsCount });
    }

    return new Response("Not found", { status: 404 });
  }

  async handleMcpProxy(request: Request): Promise<Response> {
    const body = (await request.json()) as { type?: string; tool_call?: any };

    // Discovery: return aggregated tools
    if (body.type === "mcp.discover") {
      try {
        const tools = await this.mcp.getAITools();
        return Response.json({ success: true, tools });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: "Discovery failed", message },
          { status: 500 }
        );
      }
    }

    // Tool Invocation
    if (body.type === "mcp.invoke" && body.tool_call) {
      return this.handleInvokeRequest(body.tool_call);
    }

    return Response.json(
      { error: "Unsupported MCP request type" },
      { status: 400 }
    );
  }

  private async handleInvokeRequest(tool_call: any): Promise<Response> {
    const toolName: string = tool_call.name;
    const toolArgs: Record<string, any> = tool_call.arguments || {};

    // Lookup tools
    let allTools: Record<string, any> = {};
    try {
      allTools = await this.mcp.getAITools();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: "Failed to fetch tool list", message },
        { status: 500 }
      );
    }

    // Find matching tool
    const matchingEntry = Object.entries(allTools).find(
      ([, tool]: any) => tool.name === toolName
    );

    if (!matchingEntry) {
      return Response.json(
        { error: "Tool not found", tool: toolName },
        { status: 404 }
      );
    }

    const [toolKey, toolDef]: [string, any] = matchingEntry as any;

    // Extract server id from tool key
    const parts = toolKey.split("_");
    const serverId = parts[0];

    const servers = await this.mcp.listServers();
    const server = servers.find((s: any) => s.id === serverId);

    if (!server || server.state !== "connected") {
      return Response.json(
        { error: "Server for tool unavailable", serverId },
        { status: 503 }
      );
    }

    // Execute the tool
    try {
      const result = await toolDef.execute(toolArgs);
      return Response.json({ success: true, result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: "Tool execution failed", message },
        { status: 500 }
      );
    }
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
