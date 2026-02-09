import type { Agent } from "agents";
import type { Env } from "../types";

/**
 * Initialize MCP portal connection
 */
export async function initializeMcpConnection(agent: Agent<Env, never>) {
  const portalUrl = agent.env.MCP_PORTAL_URL;

  try {
    // Check if we already have a working connection
    const existingServers = await agent.mcp.listServers();
    const workingServer = existingServers.find(
      (s: any) => s.name === "SystemMCPportal" && s.state === "connected",
    );

    if (workingServer) {
      console.log(`[Agent] Already connected to portal: ${workingServer.id}`);

      // Verify tools are available
      try {
        const tools = await agent.mcp.getAITools();
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

    // clean up ANY non-connected server
    let cleanedCount = 0;
    for (const server of existingServers) {
      if (server.state !== "connected") {
        console.log(
          `[Agent] Cleaning up ${server.state} connection: ${server.name} (${server.id})`,
        );
        try {
          await agent.mcp.removeServer(server.id);
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

    const result = await agent.addMcpServer(
      "SystemMCPportal",
      portalUrl,
      "mcp-client-agent",
      undefined,
      {
        transport: {
          type: "streamable-http",
          headers: {
            "CF-Access-Client-Id": agent.env.CFAccessClientId,
            "CF-Access-Client-Secret": agent.env.CFAccessClientSecret,
          },
        },
      },
    );

    let toolCount = 0;

    // only try to get tools if connection succeeded or is authenticating
    if (result.state === "connected" || result.state === "authenticating") {
      try {
        const tools = await agent.mcp.getAITools();
        toolCount = Object.keys(tools).length;
      } catch (e) {
        console.error("[Agent] Error fetching tools:", e);
      }
    } else if (result.state === "failed" || result.state === "error") {
      console.error(`[Agent] Connection failed with state: ${result.state}`);
      // Clean up the failed connection immediately
      try {
        await agent.mcp.removeServer(result.id);
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
