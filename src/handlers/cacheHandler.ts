import type { Agent } from "agents";
import type { Env } from "../types";
import { DataCache } from "../services/DataCache";
import { DataFetcher } from "../services/DataFetcher";

// Global cache instance (shared across requests)
let globalCache: DataCache | null = null;

/**
 * Get or create global cache instance
 */
export function getGlobalCache(): DataCache {
  if (!globalCache) {
    globalCache = new DataCache();
  }
  return globalCache;
}

/**
 * Handle cache refresh endpoint
 */
export async function handleCacheRefresh(
  agent: Agent<Env, never>,
  email: string,
): Promise<Response> {
  try {
    const cache = getGlobalCache();
    const dataFetcher = new DataFetcher();

    // Get MCP tools
    const mcpToolsResult = await agent.mcp.getAITools();
    const toolExecutorMap: Record<string, any> = {};

    Object.entries(mcpToolsResult).forEach(([toolKey, tool]: [string, any]) => {
      toolExecutorMap[toolKey] = tool;
    });

    // Refresh cache
    const success = await dataFetcher.populateCache(
      toolExecutorMap,
      email,
      cache,
    );

    const stats = cache.getStats();

    return Response.json({
      status: success ? "success" : "partial",
      message: success
        ? "Cache refreshed successfully"
        : "Cache partially refreshed",
      cache: {
        channels: stats.channelCount,
        users: stats.userCount,
        lastUpdated: stats.lastUpdated,
        isValid: stats.isValid,
      },
    });
  } catch (error) {
    console.error("[CacheHandler] Error refreshing cache:", error);
    return Response.json(
      {
        error: "Failed to refresh cache",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

/**
 * Handle cache stats endpoint
 */
export function handleCacheStats(): Response {
  const cache = getGlobalCache();
  const stats = cache.getStats();

  return Response.json({
    status: "success",
    cache: {
      channels: stats.channelCount,
      users: stats.userCount,
      lastUpdated: stats.lastUpdated,
      isValid: stats.isValid,
      isEmpty: cache.isEmpty(),
    },
  });
}

/**
 * Handle cache clear endpoint
 */
export function handleCacheClear(): Response {
  const cache = getGlobalCache();
  cache.clear();

  return Response.json({
    status: "success",
    message: "Cache cleared successfully",
  });
}
