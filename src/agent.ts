import { Agent } from "agents";
import type { Env } from "./types";
import { initializeMcpConnection } from "./handlers/mcpConnection";
import { handleHealthCheck, handleToolsEndpoint } from "./handlers/healthHandler";
import { handleChatRequest } from "./handlers/chatHandler";
import {
  handleCacheRefresh,
  handleCacheStats,
  handleCacheClear,
} from "./handlers/cacheHandler";

export class MyAgent extends Agent<Env, never> {
  async onStart() {
    await initializeMcpConnection(this);
  }


  async onRequest(request: Request, ctx?: any): Promise<Response> {
    const url = new URL(request.url);

    // health check endpoint
    if (url.pathname.endsWith("/health")) {
      return handleHealthCheck(this);
    }

    // Tools endpoint
    if (url.pathname.endsWith("/tools")) {
      return handleToolsEndpoint(this);
    }

    // Cache endpoints
    if (url.pathname.endsWith("/cache/stats")) {
      return handleCacheStats();
    }

    if (url.pathname.endsWith("/cache/clear")) {
      return handleCacheClear();
    }

    if (request.method === "POST" && url.pathname.endsWith("/cache/refresh")) {
      const body = (await request.json()) as { email: string };
      return handleCacheRefresh(this, body.email);
    }

    // Chat endpoint
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {

      const executionCtx = ctx as ExecutionContext || { 
        waitUntil: (promise: Promise<any>) => promise 
      };
      
      return handleChatRequest(request, this, executionCtx);
    }

    return new Response(`Agent "${this.name}" active.`, { status: 200 });
  }
}