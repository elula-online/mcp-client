import type { DataCache, CachedChannel, CachedUser } from "./DataCache";
import { parseToolOutput } from "../utils/resultParser";

/**
 * DataFetcher - Fetches and populates cache with channels and users
 */
export class DataFetcher {
  /**
   * Fetch all channels and users and populate cache
   */
  async populateCache(
    toolExecutorMap: Record<string, any>,
    userEmail: string,
    cache: DataCache,
  ): Promise<boolean> {
    console.log("[DataFetcher] Starting cache population...");

    try {
      // Fetch channels and users in parallel
      const [channelsResult, usersResult] = await Promise.allSettled([
        this.fetchAllChannels(toolExecutorMap, userEmail),
        this.fetchAllUsers(toolExecutorMap, userEmail),
      ]);

      let success = true;

      // Process channels
      if (channelsResult.status === "fulfilled" && channelsResult.value) {
        cache.setChannels(channelsResult.value);
      } else {
        console.error(
          "[DataFetcher] Failed to fetch channels:",
          channelsResult.status === "rejected"
            ? channelsResult.reason
            : "No data",
        );
        success = false;
      }

      // Process users
      if (usersResult.status === "fulfilled" && usersResult.value) {
        cache.setUsers(usersResult.value);
      } else {
        console.error(
          "[DataFetcher] Failed to fetch users:",
          usersResult.status === "rejected" ? usersResult.reason : "No data",
        );
        success = false;
      }

      const stats = cache.getStats();
      // console.log(
      //   `[DataFetcher] Cache populated: ${stats.channelCount} channels, ${stats.userCount} users`,
      // );

      return success;
    } catch (error) {
      console.error("[DataFetcher] Error populating cache:", error);
      return false;
    }
  }

  /**
   * Fetch all channels using available MCP tools
   */
  private async fetchAllChannels(
    toolExecutorMap: Record<string, any>,
    userEmail: string,
  ): Promise<CachedChannel[] | null> {
    // Look for channel listing tools (correct order for Mattermost)
    const listTool = this.findTool(toolExecutorMap, [
      "mattermost_list_channels",      // Correct Mattermost tool name
      "list_channels",
      "mattermost_search_channels",
      "search_channels",
      "get_channels",
    ]);

    if (!listTool) {
      // console.warn("[DataFetcher] No channel listing tool found");
      // console.log("[DataFetcher] Available tools:", Object.keys(toolExecutorMap));
      return null;
    }

    // console.log(`[DataFetcher] Using tool: ${this.getToolName(toolExecutorMap, listTool)}`);

    try {
      // Call with appropriate parameters
      const result = await listTool.execute({
        userEmail: userEmail,
      });

      const parsed = parseToolOutput(result);

      if (parsed.isError) {
        console.error("[DataFetcher] Channel fetch error:", parsed.content);
        return null;
      }

      // Parse the channels from result
      const channels = this.parseChannels(parsed.content);
      // console.log(`[DataFetcher] Parsed ${channels.length} channels`);
      return channels;
    } catch (error) {
      console.error("[DataFetcher] Error fetching channels:", error);
      return null;
    }
  }

  /**
   * Fetch all users using available MCP tools
   */
  private async fetchAllUsers(
    toolExecutorMap: Record<string, any>,
    userEmail: string,
  ): Promise<CachedUser[] | null> {
    // Look for user listing tools (correct order for Mattermost)
    const userTool = this.findTool(toolExecutorMap, [
      "mattermost_get_users",          // Correct Mattermost tool name
      "get_users",
      "list_users",
      "search_users",
    ]);

    if (!userTool) {
      // console.warn("[DataFetcher] No user listing tool found");
      // console.log("[DataFetcher] Available tools:", Object.keys(toolExecutorMap));
      return null;
    }

    // console.log(`[DataFetcher] Using tool: ${this.getToolName(toolExecutorMap, userTool)}`);

    try {
      // Call with appropriate parameters
      const result = await userTool.execute({
        userEmail: userEmail,
      });

      const parsed = parseToolOutput(result);

      if (parsed.isError) {
        console.error("[DataFetcher] User fetch error:", parsed.content);
        return null;
      }

      // Parse the users from result
      const users = this.parseUsers(parsed.content);
      // console.log(`[DataFetcher] Parsed ${users.length} users`);
      return users;
    } catch (error) {
      console.error("[DataFetcher] Error fetching users:", error);
      return null;
    }
  }

  /**
   * Find a tool by checking multiple possible names
   */
  private findTool(
    toolExecutorMap: Record<string, any>,
    possibleNames: string[],
  ): any | null {
    for (const name of possibleNames) {
      // Check exact match
      if (toolExecutorMap[name]) {
        // console.log(`[DataFetcher] Found exact match: ${name}`);
        return toolExecutorMap[name];
      }

      // Check partial match (case insensitive)
      const found = Object.keys(toolExecutorMap).find((key) =>
        key.toLowerCase().includes(name.toLowerCase()),
      );
      if (found) {
        // console.log(`[DataFetcher] Found partial match: ${found} (looking for ${name})`);
        return toolExecutorMap[found];
      }
    }
    // console.warn(`[DataFetcher] No tool found matching: ${possibleNames.join(", ")}`);
    return null;
  }

  /**
   * Get tool name for logging
   */
  private getToolName(toolExecutorMap: Record<string, any>, tool: any): string {
    for (const [name, t] of Object.entries(toolExecutorMap)) {
      if (t === tool) return name;
    }
    return "unknown";
  }

  /**
   * Parse channels from tool result
   */
  private parseChannels(content: string): CachedChannel[] {
    try {
      const data = JSON.parse(content);

      // Log the structure for debugging
      // console.log("[DataFetcher] Channel data structure:", Object.keys(data).join(", "));

      // Try different possible structures
      const channelArray =
        data.channels || 
        data.data || 
        data.results || 
        data.items ||
        (Array.isArray(data) ? data : []);

      if (!Array.isArray(channelArray)) {
        // console.warn("[DataFetcher] Channel data is not an array:", typeof channelArray);
        // console.warn("[DataFetcher] Data keys:", Object.keys(data));
        return [];
      }

      // console.log(`[DataFetcher] Found ${channelArray.length} channels in response`);

      const parsed = channelArray
        .map((ch: any) => ({
          id: ch.id || ch.channel_id || "",
          name: ch.name || "",
          display_name: ch.display_name || ch.displayName || ch.name || "",
          type: ch.type || "unknown",
        }))
        .filter((ch) => ch.id && ch.name); // Only include valid channels

      // console.log(`[DataFetcher] Successfully parsed ${parsed.length} valid channels`);
      return parsed;
    } catch (error) {
      console.error("[DataFetcher] Error parsing channels:", error);
      console.error("[DataFetcher] Content that failed to parse:", content.substring(0, 200));
      return [];
    }
  }

  /**
   * Parse users from tool result
   */
  private parseUsers(content: string): CachedUser[] {
    try {
      const data = JSON.parse(content);

      // Log the structure for debugging
      // console.log("[DataFetcher] User data structure:", Object.keys(data).join(", "));

      // Try different possible structures
      const userArray =
        data.users || 
        data.data || 
        data.results || 
        data.items ||
        (Array.isArray(data) ? data : []);

      if (!Array.isArray(userArray)) {
        // console.warn("[DataFetcher] User data is not an array:", typeof userArray);
        // console.warn("[DataFetcher] Data keys:", Object.keys(data));
        return [];
      }

      // console.log(`[DataFetcher] Found ${userArray.length} users in response`);

      const parsed = userArray
        .map((u: any) => ({
          id: u.id || u.user_id || "",
          username: u.username || u.name || "",
          email: u.email || "",
          first_name: u.first_name || u.firstName || "",
          last_name: u.last_name || u.lastName || "",
        }))
        .filter((u) => u.id && u.username); // Only include valid users

      // console.log(`[DataFetcher] Successfully parsed ${parsed.length} valid users`);
      return parsed;
    } catch (error) {
      console.error("[DataFetcher] Error parsing users:", error);
      console.error("[DataFetcher] Content that failed to parse:", content.substring(0, 200));
      return [];
    }
  }

  /**
   * Refresh cache if needed
   */
  async refreshIfNeeded(
    toolExecutorMap: Record<string, any>,
    userEmail: string,
    cache: DataCache,
  ): Promise<void> {
    if (!cache.isValid() || cache.isEmpty()) {
      // console.log("[DataFetcher] Cache invalid or empty, refreshing...");
      await this.populateCache(toolExecutorMap, userEmail, cache);
    } else {
      // console.log("[DataFetcher] Cache is valid, skipping refresh");
    }
  }
}
