import type { Agent } from "agents";
import type { Env } from "../types";

/**
 * Handle health check endpoint
 */
export async function handleHealthCheck(agent: Agent<Env, never>): Promise<Response> {
  try {
    const servers = await agent.mcp.listServers();

    // only count tools from connected servers
    const connectedServers = servers.filter(
      (s: any) => s.state === "connected",
    );

    let toolCount = 0;
    if (connectedServers.length > 0) {
      try {
        const mcpTools = await agent.mcp.getAITools();
        toolCount = Object.keys(mcpTools).length;
      } catch (e) {
        console.warn("[Health] Could not fetch tools:", e);
      }
    }

    const status = {
      status: toolCount > 0 ? "healthy" : "initializing",
      agent_instance: agent.name,
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

/**
 * Handle tools listing endpoint
 */
export async function handleToolsEndpoint(agent: Agent<Env, never>): Promise<Response> {
  try {
    const tools = await agent.mcp.getAITools();
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
