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
      // Check if we already have a working connection
      const existingServers = await this.mcp.listServers();
      const workingServer = existingServers.find(
        (s: any) => s.name === "SystemMCPportal" && s.state === "connected",
      );

      if (workingServer) {
        console.log(`[Agent] Already connected to portal: ${workingServer.id}`);

        // Verify tools are available
        try {
          const tools = await this.mcp.getAITools();
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

      // CRITICAL FIX: Clean up ANY non-connected server
      // This includes: failed, error, authenticating, AND unknown states
      let cleanedCount = 0;
      for (const server of existingServers) {
        if (server.state !== "connected") {
          console.log(
            `[Agent] Cleaning up ${server.state} connection: ${server.name} (${server.id})`,
          );
          try {
            await this.mcp.removeServer(server.id);
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

      const result = await this.addMcpServer(
        "SystemMCPportal",
        portalUrl,
        "mcp-client-agent",
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

      let toolCount = 0;

      // Only try to get tools if connection succeeded or is authenticating
      if (result.state === "connected" || result.state === "authenticating") {
        try {
          const tools = await this.mcp.getAITools();
          toolCount = Object.keys(tools).length;
        } catch (e) {
          console.error("[Agent] Error fetching tools:", e);
        }
      } else if (result.state === "failed" || result.state === "error") {
        console.error(`[Agent] Connection failed with state: ${result.state}`);
        // Clean up the failed connection immediately
        try {
          await this.mcp.removeServer(result.id);
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

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname.endsWith("/health")) {
      try {
        const servers = await this.mcp.listServers();

        // Only count tools from connected servers
        const connectedServers = servers.filter(
          (s: any) => s.state === "connected",
        );

        let toolCount = 0;
        if (connectedServers.length > 0) {
          try {
            const mcpTools = await this.mcp.getAITools();
            toolCount = Object.keys(mcpTools).length;
          } catch (e) {
            console.warn("[Health] Could not fetch tools:", e);
          }
        }

        const status = {
          status: toolCount > 0 ? "healthy" : "initializing",
          agent_instance: this.name,
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

    // Tools endpoint
    if (url.pathname.endsWith("/tools")) {
      try {
        const tools = await this.mcp.getAITools();
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

    // Chat endpoint
    // Chat endpoint
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      try {
        const { prompt } = (await request.json()) as { prompt: string };

        // connection state before attempting to use tools
        const servers = await this.mcp.listServers();
        const connectedServers = servers.filter(
          (s: any) => s.name === "SystemMCPportal" && s.id,
        );

        if (connectedServers.length === 0) {
          console.warn("[Chat] No connected MCP servers available");
          await this.onStart();
          const serversAfterReconnect = await this.mcp.listServers();
          const reconnectedServers = serversAfterReconnect.filter(
            (s: any) => s.state === "connected",
          );

          if (reconnectedServers.length === 0) {
            return Response.json(
              {
                error: "No connected MCP servers available",
                suggestion:
                  "The MCP portal may be down or unreachable. Please try again later.",
              },
              { status: 503 },
            );
          }
        }

        //fetch tools with retry logic
        let attempts = 0;
        const MAX_ATTEMPTS = 5;
        let mcpToolsResult: Record<string, any> = {};

        while (
          Object.keys(mcpToolsResult).length === 0 &&
          attempts < MAX_ATTEMPTS
        ) {
          try {
            mcpToolsResult = await this.mcp.getAITools();
            if (Object.keys(mcpToolsResult).length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 1500));
          } catch (error) {
            console.error(`[Chat] Tool fetch error:`, error);
          }
          attempts++;
        }

        if (Object.keys(mcpToolsResult).length === 0) {
          return Response.json(
            { error: "No MCP tools available after retry" },
            { status: 503 },
          );
        }

        const gateway = this.env.AI.gateway(this.env.GATEWAY_ID);
        const toolExecutorMap: Record<string, any> = {};

        const tools = Object.entries(mcpToolsResult).map(
          ([toolKey, tool]: [string, any]) => {
            const displayName = tool.name || toolKey;
            toolExecutorMap[displayName] = tool;
            return {
              type: "function",
              function: {
                name: displayName,
                description: tool.description,
                parameters: tool.inputSchema.jsonSchema,
              },
            };
          },
        );

        const systemPrompt = `You are a professional production assistant.

Your job is to reason like an engineer but respond like a polished product UI.

---

## YOUR STRATEGY
1. DISCOVERY 
If a user asks for something by name (e.g. "stats on the dev channel") and you don't have an ID, use a discovery tool first (list/search).

2. SEQUENTIAL STEPS 
You may call multiple tools in sequence when needed.
Example: List Channels → Find "Dev" → Get stats for that channel.

3. AMBIGUITY HANDLING 
If multiple results match (e.g. two "Dev" channels), stop and ask the user to clarify before continuing.

4. TOOL-THEN-NARRATE 
Tool outputs are NEVER the final response.
Always analyze the tool result and convert it into a clear, human-readable explanation.

---

## RESPONSE & FORMATTING RULES
1. Use Markdown formatting suitable for web apps:
 - ### Headings for sections
 - Bullet lists instead of long paragraphs
 - **Bold** for key outcomes or confirmations
 - Short, readable paragraphs

2. Explain results clearly:
 - What was done
 - What the outcome is
 - Any important implications or limits

3. NEVER expose:
 - Raw JSON
 - Internal IDs
 - Tool arguments
 - System or technical metadata

4. Always end with a helpful next step or suggestion.

---

## ACTION-AWARE RESPONSES (CRITICAL)
If a tool performs an action (post, send, update, delete, trigger, create):

- Respond in a **user-facing, confirmation tone**
- Use past tense and ownership
- Frame the response from the user's perspective

Examples:
- "I've posted your message to the Dev channel."
- "Your announcement has been successfully sent."
- "The channel description has been updated."

Do NOT say:
- "The tool returned success"
- "API response indicates"
- "Status code 200"

---

## HANDLING MISSING INFORMATION
- If a required value (e.g. channel_id) is missing, use a discovery tool first.
- If the information still cannot be found:
  Ask the user clearly and politely.

Example:
"I couldn't find a channel named **Dev**. Could you double-check the name or tell me which one you mean?"

---

## CRITICAL EXECUTION RULES
1. **ALWAYS provide a text response after using tools** - Analyze tool outputs and summarize them for the user
2. **NEVER leave your response empty** - If you call a tool, you MUST explain what happened
3. **If a tool was already executed**, use the previous result to provide your answer
4. **Stop calling tools once you have the information** you need to answer the user

---

## DATA FLOW RULE
Reason internally, respond externally.
Only the final, polished explanation is shown to the user.`;

        let messages: Message[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ];

        let isRunning = true;
        let loopCount = 0;
        const MAX_LOOPS = 3;

        // track tool executions by creating a unique signature: toolName + arguments
        const executedToolSignatures = new Set<string>();
        let hasExecutedAnyTool = false;

        while (isRunning && loopCount < MAX_LOOPS) {
          loopCount++;

          // after executing tools, disable them to force text response
          const shouldAllowTools = !hasExecutedAnyTool;

          const response = await gateway.run({
            provider: "workers-ai",
            endpoint: "@cf/meta/llama-3.1-70b-instruct",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN || "LOCAL_AUTH_FALLBACK"}`,
            },
            query: {
              messages: messages,
              tools: shouldAllowTools ? tools : [],
              tool_choice: shouldAllowTools ? "auto" : "none",
            },
          });

          const result = await response.json();
          if (!result.success) {
            return Response.json(
              { error: "Gateway Error", details: result },
              { status: 500 },
            );
          }

          const toolCalls = result.result.tool_calls || [];
          const assistantContent = result.result.response || "";

          // if we have text content, we're done
          if (!shouldAllowTools || toolCalls.length === 0) {
            if (assistantContent && assistantContent.trim().length > 0) {
              messages.push({
                role: "assistant",
                content: assistantContent,
              });
              isRunning = false;
              break;
            } else if (!shouldAllowTools) {
              // we disabled tools but LLM still didnot respond - force it
              console.warn("[Chat] LLM failed to respond after tool execution");
              messages.push({
                role: "user",
                content:
                  "Based on the tool results above, please provide a clear, user-friendly summary of what was accomplished. Write as if you're confirming the action to the user.",
              });
              continue;
            }
          }

          // assistant Message with tool calls
          let assistantMessage: Message = {
            role: "assistant",
            content: assistantContent,
          };
          if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
          messages.push(assistantMessage);

          // process tool calls
          let toolsExecutedThisRound = 0;

          for (const toolCall of toolCalls) {
            const { name, arguments: args, id: callId } = toolCall;

            // create a unique signature for this specific tool call
            const argsString =
              typeof args === "string" ? args : JSON.stringify(args);
            const toolSignature = `${name}::${argsString}`;

            // PREVENT DUPLICATE TOOL EXECUTION
            if (executedToolSignatures.has(toolSignature)) {
              console.warn(`[Chat] Blocking duplicate: ${name}`);
              continue;
            }

            const tool = toolExecutorMap[name];
            if (tool) {
              try {
                let parsedArgs =
                  typeof args === "string" ? JSON.parse(args) : { ...args };

                // convert string numbers to actual numbers
                for (const key in parsedArgs) {
                  const value = parsedArgs[key];
                  if (
                    typeof value === "string" &&
                    value.trim() !== "" &&
                    !isNaN(Number(value))
                  ) {
                    parsedArgs[key] = Number(value);
                  }
                }

                // execution
                console.log(`[Chat] Executing: ${name} with args:`, parsedArgs);
                const toolOutput = await tool.execute(parsedArgs);

                // mark this specific tool call as executed
                executedToolSignatures.add(toolSignature);
                hasExecutedAnyTool = true;
                toolsExecutedThisRound++;

                // clean and parse the tool output
                let cleanContent;

                if (toolOutput.result?.content?.[0]?.text) {
                  cleanContent = toolOutput.result.content[0].text;
                } else if (typeof toolOutput === "string") {
                  cleanContent = toolOutput;
                } else {
                  cleanContent = JSON.stringify(toolOutput);
                }

                // try to parse nested JSON if present
                try {
                  const parsed = JSON.parse(cleanContent);
                  if (parsed.content?.[0]?.text) {
                    cleanContent = parsed.content[0].text;
                  }
                } catch {
                  // not nested JSON, use as-is
                }

                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: cleanContent,
                });
              } catch (e: any) {
                console.error(`[Chat] Tool execution error:`, e);
                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  name: name,
                  content: JSON.stringify({
                    error: "Tool execution failed",
                    details: e.message,
                  }),
                });
                hasExecutedAnyTool = true;
              }
            } else {
              messages.push({
                role: "tool",
                tool_call_id: callId,
                name: name,
                content: JSON.stringify({
                  error: "Tool not found",
                  details: `Tool ${name} is not available`,
                }),
              });
            }
          }

          // after executing tools, add a prompt to encourage response
          if (toolsExecutedThisRound > 0) {
            messages.push({
              role: "user",
              content:
                "Now provide a user-friendly summary of what was done. Be specific about the action that was completed.",
            });
          }
        }

        if (loopCount >= MAX_LOOPS) {
          console.warn(`[Chat] Reached maximum loop count (${MAX_LOOPS})`);
        }

        // final content extraction: get the last assistant message that actually has text
        const finalAssistantMessage = messages
          .filter(
            (m) =>
              m.role === "assistant" &&
              m.content &&
              m.content.trim().length > 0,
          )
          .pop();

        let finalAnswer = finalAssistantMessage?.content || "";

        // if we still donot have a good answer, generate one from the tool results
        if (
          !finalAnswer ||
          finalAnswer.trim().length === 0 ||
          finalAnswer.startsWith("{")
        ) {
          console.warn(
            "[Chat] No valid text response, generating from tool results",
          );

          // find the last successful tool execution
          const toolMessages = messages.filter((m) => m.role === "tool");
          const lastToolMessage = toolMessages[toolMessages.length - 1];

          if (lastToolMessage) {
            try {
              const toolResult = JSON.parse(lastToolMessage.content);

              // generate a user-friendly response based on tool result
              if (toolResult.success) {
                const toolName = lastToolMessage.name || "action";

                // extract action type from tool name
                if (
                  toolName.includes("post_message") ||
                  toolName.includes("send")
                ) {
                  finalAnswer = `**Message sent successfully!**\n\nYour message has been posted to the channel.`;
                } else if (toolName.includes("create")) {
                  finalAnswer = `**Created successfully!**\n\nThe item has been created.`;
                } else if (toolName.includes("update")) {
                  finalAnswer = `**Updated successfully!**\n\nThe changes have been saved.`;
                } else if (toolName.includes("delete")) {
                  finalAnswer = `**Deleted successfully!**\n\nThe item has been removed.`;
                } else if (
                  toolName.includes("list") ||
                  toolName.includes("get")
                ) {
                  finalAnswer = `**Retrieved successfully!**\n\nI've fetched the requested information.`;
                } else {
                  finalAnswer = `**Action completed successfully!**\n\nThe requested operation has been performed.`;
                }
              } else if (toolResult.error) {
                finalAnswer = `**Action encountered an issue**\n\n${toolResult.error}\n\n${toolResult.details || "Please try again or contact support."}`;
              }
            } catch {
              // tool result wasnot JSON, try to use it directly
              if (lastToolMessage.content.includes("success")) {
                finalAnswer = `**Action completed!**\n\nYour request has been processed successfully.`;
              } else {
                finalAnswer = `**Action completed**\n\n${lastToolMessage.content.substring(0, 200)}`;
              }
            }
          } else {
            finalAnswer =
              "I've processed your request, but I'm having trouble generating a detailed summary. Please try asking again with more specifics.";
          }
        }

        // clean up any JSON artifacts from the response
        if (finalAnswer.startsWith("{") && finalAnswer.includes('"name":')) {
          console.warn(
            "[Chat] Detected tool call in response, replacing with fallback",
          );
          finalAnswer = `**Request processed!**\n\nI've completed the action you requested.`;
        }

        return Response.json({
          status: "success",
          answer: finalAnswer,
        });
      } catch (error) {
        console.error("[Chat] Unexpected error:", error);
        return Response.json(
          {
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
          },
          { status: 500 },
        );
      }
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
