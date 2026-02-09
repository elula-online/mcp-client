import { Agent } from "agents";
import type { Env } from "./types";
import { initializeMcpConnection } from "./handlers/mcpConnection";
import { handleHealthCheck, handleToolsEndpoint } from "./handlers/healthHandler";
import { handleChatRequest } from "./handlers/chatHandler";

export class MyAgent extends Agent<Env, never> {
  async onStart() {
    await initializeMcpConnection(this);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // health check endpoint
    if (url.pathname.endsWith("/health")) {
      return handleHealthCheck(this);
    }

    // Tools endpoint
    if (url.pathname.endsWith("/tools")) {
      return handleToolsEndpoint(this);
    }

    // Chat endpoint
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      return handleChatRequest(request, this);
    }

    return new Response(`Agent "${this.name}" active.`, { status: 200 });
  }
}
