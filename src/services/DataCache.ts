/**
 * DataCache - Caches channels and users to reduce LLM calls
 * 
 * By loading all channels and users upfront, we can provide this context
 * to the LLM, eliminating the need for search tool calls.
 */

export interface CachedChannel {
  id: string;
  name: string;
  display_name: string;
  type: string;
}

export interface CachedUser {
  id: string;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
}

export interface CacheStats {
  channelCount: number;
  userCount: number;
  lastUpdated: Date;
  isValid: boolean;
}

/**
 * DataCache stores frequently accessed data to reduce tool calls
 */
export class DataCache {
  private channels: Map<string, CachedChannel> = new Map();
  private users: Map<string, CachedUser> = new Map();
  private lastUpdated: Date | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Add channels to cache
   */
  setChannels(channels: CachedChannel[]): void {
    this.channels.clear();
    for (const channel of channels) {
      // Store by both id and name for easy lookup
      this.channels.set(channel.id, channel);
      this.channels.set(channel.name.toLowerCase(), channel);
      if (channel.display_name) {
        this.channels.set(channel.display_name.toLowerCase(), channel);
      }
    }
    this.lastUpdated = new Date();
    console.log(`[DataCache] Cached ${channels.length} channels`);
  }

  /**
   * Add users to cache
   */
  setUsers(users: CachedUser[]): void {
    this.users.clear();
    for (const user of users) {
      // Store by id, username, and email
      this.users.set(user.id, user);
      this.users.set(user.username.toLowerCase(), user);
      this.users.set(user.email.toLowerCase(), user);
    }
    console.log(`[DataCache] Cached ${users.length} users`);
  }

  /**
   * Get channel by name or ID
   */
  getChannel(nameOrId: string): CachedChannel | undefined {
    return this.channels.get(nameOrId.toLowerCase());
  }

  /**
   * Get user by username, email, or ID
   */
  getUser(usernameOrEmailOrId: string): CachedUser | undefined {
    return this.users.get(usernameOrEmailOrId.toLowerCase());
  }

  /**
   * Get all channels
   */
  getAllChannels(): CachedChannel[] {
    const seen = new Set<string>();
    const channels: CachedChannel[] = [];
    
    for (const channel of this.channels.values()) {
      if (!seen.has(channel.id)) {
        seen.add(channel.id);
        channels.push(channel);
      }
    }
    
    return channels;
  }

  /**
   * Get all users
   */
  getAllUsers(): CachedUser[] {
    const seen = new Set<string>();
    const users: CachedUser[] = [];
    
    for (const user of this.users.values()) {
      if (!seen.has(user.id)) {
        seen.add(user.id);
        users.push(user);
      }
    }
    
    return users;
  }

  /**
   * Check if cache is still valid
   */
  isValid(): boolean {
    if (!this.lastUpdated) return false;
    const age = Date.now() - this.lastUpdated.getTime();
    return age < this.CACHE_TTL_MS;
  }

  /**
   * Check if cache is empty
   */
  isEmpty(): boolean {
    return this.channels.size === 0 && this.users.size === 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return {
      channelCount: new Set(
        Array.from(this.channels.values()).map((c) => c.id)
      ).size,
      userCount: new Set(Array.from(this.users.values()).map((u) => u.id))
        .size,
      lastUpdated: this.lastUpdated || new Date(0),
      isValid: this.isValid(),
    };
  }

  /**
   * Format channels for LLM context
   */
  formatChannelsForLLM(): string {
    const channels = this.getAllChannels();
    if (channels.length === 0) return "No channels available.";

    const formatted = channels
      .map((ch) => {
        const displayName = ch.display_name || ch.name;
        return `- ${displayName} (${ch.name}) [ID: ${ch.id}]`;
      })
      .join("\n");

    return `Available Channels (${channels.length}):\n${formatted}`;
  }

  /**
   * Format users for LLM context
   */
  formatUsersForLLM(): string {
    const users = this.getAllUsers();
    if (users.length === 0) return "No users available.";

    const formatted = users
      .map((user) => {
        const fullName =
          user.first_name || user.last_name
            ? `${user.first_name || ""} ${user.last_name || ""}`.trim()
            : "";
        const displayName = fullName ? `${fullName} (@${user.username})` : `@${user.username}`;
        return `- ${displayName} <${user.email}> [ID: ${user.id}]`;
      })
      .join("\n");

    return `Available Users (${users.length}):\n${formatted}`;
  }

  /**
   * Format compact list for LLM (names only)
   */
  formatCompactChannelsForLLM(): string {
    const channels = this.getAllChannels();
    if (channels.length === 0) return "No channels available.";

    const names = channels
      .map((ch) => ch.display_name || ch.name)
      .join(", ");
    
    return `Available Channels (${channels.length}): ${names}`;
  }

  /**
   * Format compact user list for LLM
   */
  formatCompactUsersForLLM(): string {
    const users = this.getAllUsers();
    if (users.length === 0) return "No users available.";

    const usernames = users.map((u) => `@${u.username}`).join(", ");
    
    return `Available Users (${users.length}): ${usernames}`;
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.channels.clear();
    this.users.clear();
    this.lastUpdated = null;
    console.log("[DataCache] Cache cleared");
  }
}
