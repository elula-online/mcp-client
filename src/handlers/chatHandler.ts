import type { Agent } from "agents";
import type { Env, Message, ToolExecution } from "../types";
import {
  sanitizeToolArgs,
  extractDiscoveredIds,
  analyzeToolError,
  createErrorRecoveryPrompt,
} from "../utils/toolUtils";
import systemPrompt from "../systemPrompt";
import { initializeMcpConnection } from "./mcpConnection";

/**
 * Handle chat endpoint - main agent loop
 */
export async function handleChatRequest(
  request: Request,
  agent: Agent<Env, never>
): Promise<Response> {
  try {
    const { prompt, email } = (await request.json()) as {
      prompt: string;
      email: string;
    };

    // check connection state before attempting to use tools
    const servers = await agent.mcp.listServers();
    const connectedServers = servers.filter(
      (s: any) => s.name === "SystemMCPportal" && s.id,
    );

    if (connectedServers.length === 0) {
      console.warn("[Chat] No connected MCP servers available");
      await initializeMcpConnection(agent);
      const serversAfterReconnect = await agent.mcp.listServers();
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

    // fetch tools with retry logic
    let attempts = 0;
    const MAX_ATTEMPTS = 5;
    let mcpToolsResult: Record<string, any> = {};

    while (
      Object.keys(mcpToolsResult).length === 0 &&
      attempts < MAX_ATTEMPTS
    ) {
      try {
        mcpToolsResult = await agent.mcp.getAITools();
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

    const gateway = agent.env.AI.gateway(agent.env.GATEWAY_ID);
    const toolExecutorMap: Record<string, any> = {};

    const tools = Object.entries(mcpToolsResult).map(
      ([toolKey, tool]: [string, any]) => {
        toolExecutorMap[toolKey] = tool;
        return {
          type: "function",
          function: {
            name: toolKey,
            description: tool.description,
            parameters: tool.inputSchema.jsonSchema,
          },
        };
      },
    );

    let messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    let isRunning = true;
    let loopCount = 0;
    const MAX_LOOPS = 10;

    // Track tool executions with detailed metadata
    const toolExecutionHistory = new Map<string, ToolExecution>();
    const successfulToolCalls = new Set<string>();

    // Track discovered IDs to prevent redundant searches
    const discoveredIds = new Map<string, string>();

    // main agent loop
    let consecutiveFailedAttempts = 0;
    let lastFailedToolName = "";

    while (isRunning && loopCount < MAX_LOOPS) {
      loopCount++;
      console.log(`[Agent] Loop ${loopCount}/${MAX_LOOPS}`);

      const shouldForceAnswer = loopCount >= MAX_LOOPS - 1;

      // Add guidance on first loop to prevent LLM from describing what it will do
      if (loopCount === 1) {
        messages.push({
          role: "system",
          content: `CRITICAL INSTRUCTION: When you need information, you must IMMEDIATELY call the appropriate tool. DO NOT describe what you plan to do, what parameters you need, or what the request should include. Just call the tool directly.

Example - WRONG: "To get channel statistics, the request should include channel: paraat ai and message_limit: 100"
Example - CORRECT: [Immediately calls the tool with those parameters]

Call tools NOW when needed, don't describe your plan.`,
        });
      }

      const response = await gateway.run({
        provider: "openai",
        endpoint: "chat/completions",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${agent.env.OPENAI_API_KEY}`,
        },
        query: {
          model: "gpt-4o",
          messages: messages,
          tools: shouldForceAnswer ? [] : tools,
          tool_choice: shouldForceAnswer ? "none" : "auto",
          max_tokens: 1000,
        },
      });

      const result = await response.json();

      // OpenAI response format
      if (!result.choices || !result.choices[0]) {
        return Response.json(
          { error: "Gateway Error", details: result },
          { status: 500 },
        );
      }

      const choice = result.choices[0];
      const toolCalls = choice.message?.tool_calls || [];
      const assistantContent = choice.message?.content || "";

      // Detect "Leaky JSON". If LLM outputs raw JSON in text instead of tool_call, reject it.
      if (
        toolCalls.length === 0 &&
        assistantContent.trim().startsWith("{")
      ) {
        if (
          assistantContent.includes('"name":') ||
          assistantContent.includes('"parameters":')
        ) {
          console.warn(
            "[Agent] Detected leaked JSON. Rejecting and prompting for retry.",
          );

          messages.push({
            role: "assistant",
            content: assistantContent,
          });

          messages.push({
            role: "user",
            content: `SYSTEM ERROR: You outputted the tool call as raw text JSON. 
                   
STOP. Do not write JSON in the response text. 
You must use the 'tool_calls' field protocol to execute tools.
Retry the tool call now correctly.`,
          });

          continue;
        }
      }

      // if LLM provides a text response with no tool calls, check for technical jargon
      if (
        toolCalls.length === 0 &&
        assistantContent &&
        assistantContent.trim().length > 0
      ) {
        // Detect if LLM is describing what it WOULD do instead of doing it
        const isDescribingToolCall =
          /the request (should|would|will) include/i.test(
            assistantContent,
          ) ||
          /request details are/i.test(assistantContent) ||
          /to (get|fetch|retrieve).*(the request|I need|should include)/i.test(
            assistantContent,
          ) ||
          /(channel|user|message):\s*[a-z]/i.test(assistantContent);

        if (isDescribingToolCall && loopCount < MAX_LOOPS - 3) {
          console.warn(
            "[Agent] LLM is describing tool parameters instead of calling the tool. Redirecting.",
          );
          messages.push({
            role: "assistant",
            content: assistantContent,
          });
          messages.push({
            role: "user",
            content: `CRITICAL ERROR: You are DESCRIBING what you would do instead of DOING it.

DO NOT explain what parameters you need or what the request should include.
IMMEDIATELY call the appropriate tool with the parameters you just described.

Call the tool NOW.`,
          });
          continue;
        }

        // Detect if response contains technical jargon that should not be shown to users
        const hasTechnicalJargon =
          /tool_[a-zA-Z0-9_]+_mattermost/i.test(assistantContent) ||
          /\bfunction\s+(call|name)/i.test(assistantContent) ||
          /\bparameter(s)?\s+(is|are|was|were)/i.test(assistantContent) ||
          /channel_id.*[a-z0-9]{26}/i.test(assistantContent) ||
          /I was unable to.*using the.*(function|tool)/i.test(
            assistantContent,
          ) ||
          /I have already provided.*in my previous response/i.test(
            assistantContent,
          );

        if (hasTechnicalJargon && loopCount < MAX_LOOPS - 1) {
          console.warn(
            "[Agent] Technical jargon detected in response. Requesting rewrite.",
          );
          messages.push({
            role: "assistant",
            content: assistantContent,
          });
          messages.push({
            role: "user",
            content: `CRITICAL: Your response contains technical implementation details that users should not see. Please use line breaks \\n\ and other formatters.

Rewrite your response following these rules:
1. NEVER mention tool names, function names, or technical processes
2. Present only the final result or information in a natural, friendly way
4. If something failed, just say what the issue is simply without explaining your troubleshooting process

Rewrite your response now.`,
          });
          continue;
        }

        messages.push({
          role: "assistant",
          content: assistantContent,
        });
        isRunning = false;
        break;
      }

      // If no tool calls and no content, prompt for response
      if (toolCalls.length === 0 && !assistantContent) {
        console.warn(
          "[Agent] LLM provided neither tool calls nor text response",
        );
        messages.push({
          role: "user",
          content: `Provide your answer to the user now based on the information you've gathered. Do not mention any technical details. Please use line breaks \\n\ and other formatters.`,
        });
        continue;
      }

      // If LLM wants to call tools, process them
      if (toolCalls.length > 0) {
        // Add assistant message with tool calls
        let assistantMessage: Message = {
          role: "assistant",
          content: assistantContent || "",
        };
        assistantMessage.tool_calls = toolCalls;
        messages.push(assistantMessage);

        // Process each tool call
        for (const toolCall of toolCalls) {
          const name = toolCall.function?.name || toolCall.name;
          const args = toolCall.function?.arguments || toolCall.arguments;
          const callId = toolCall.id;

          // Parse and sanitize arguments
          let parsedArgs =
            typeof args === "string" ? JSON.parse(args) : { ...args };
          parsedArgs = sanitizeToolArgs(name, parsedArgs, email);

          // Create unique signature for this tool call
          const argsString = JSON.stringify(parsedArgs);
          const toolSignature = `${name}::${argsString}`;

          // CONSTRAINT 1: Prevent calling a tool that already succeeded
          if (successfulToolCalls.has(toolSignature)) {
            console.warn(
              `[Agent] Blocking duplicate call: ${name} - forcing final response`,
            );

            const previousResult =
              toolExecutionHistory.get(toolSignature)?.result;

            messages.push({
              role: "tool",
              tool_call_id: callId,
              name: name,
              content: previousResult || "Action completed successfully.",
            });

            messages.push({
              role: "user",
              content: `CRITICAL: You are trying to repeat an action that was already completed.

You MUST stop calling tools and provide a user-friendly response NOW. Please use line breaks \\n\ and other formatters

Requirements:
- Confirm what was done
- no technical terms
- Be brief and friendly

Respond to the user immediately.`,
            });

            break;
          }

          const tool = toolExecutorMap[name];
          if (!tool) {
            messages.push({
              role: "tool",
              tool_call_id: callId,
              name: name,
              content: JSON.stringify({
                error: "Tool not found",
                details: `Tool ${name} is not available`,
              }),
            });
            continue;
          }

          try {
            // Execute the tool
            console.log(
              `[Agent] Executing: ${name} with args:`,
              parsedArgs,
            );
            const toolOutput = await tool.execute(parsedArgs);

            // Extract clean content from tool output
            let cleanContent;
            if (toolOutput.result?.content?.[0]?.text) {
              cleanContent = toolOutput.result.content[0].text;
            } else if (typeof toolOutput === "string") {
              cleanContent = toolOutput;
            } else {
              cleanContent = JSON.stringify(toolOutput);
            }

            // Try to parse nested JSON if present
            try {
              const parsed = JSON.parse(cleanContent);
              if (parsed.content?.[0]?.text) {
                cleanContent = parsed.content[0].text;
              }

              console.log("Tool result: ", cleanContent);
            } catch {
              // Not nested JSON, use as-is
            }

            // Check if tool execution was successful
            const isSuccess =
              !cleanContent.toLowerCase().includes('"error"') &&
              !cleanContent.toLowerCase().includes('"success": false') &&
              !cleanContent.toLowerCase().includes("404") &&
              !cleanContent.toLowerCase().includes("not found") &&
              !cleanContent.toLowerCase().includes("user not found");

            if (isSuccess) {
              // Mark as successful to prevent re-execution
              successfulToolCalls.add(toolSignature);
              toolExecutionHistory.set(toolSignature, {
                signature: toolSignature,
                result: cleanContent,
                success: true,
              });

              // Extract IDs from search results
              extractDiscoveredIds(name, cleanContent, discoveredIds);

              messages.push({
                role: "tool",
                tool_call_id: callId,
                name: name,
                content: cleanContent,
              });

              console.log(`[Agent] ✓ Tool ${name} succeeded`);

              // Reset failure tracking on success
              consecutiveFailedAttempts = 0;
              lastFailedToolName = "";
            } else {
              // CONSTRAINT 2: Tool failed - analyze error and provide recovery guidance
              const errorAnalysis = analyzeToolError(
                name,
                cleanContent,
                parsedArgs,
              );

              toolExecutionHistory.set(toolSignature, {
                signature: toolSignature,
                result: cleanContent,
                success: false,
                errorType: errorAnalysis.errorType,
              });

              messages.push({
                role: "tool",
                tool_call_id: callId,
                name: name,
                content: cleanContent,
              });

              // CRITICAL: If this is a user authentication error, immediately force response
              if (errorAnalysis.errorType === "user_auth_error") {
                console.warn(
                  `[Agent] User authentication error detected. Forcing immediate user response.`,
                );

                const recoveryPrompt = createErrorRecoveryPrompt(
                  name,
                  errorAnalysis,
                  parsedArgs,
                  discoveredIds,
                );

                messages.push({
                  role: "user",
                  content:
                    recoveryPrompt ||
                    `CRITICAL: Authentication failed. Inform the user they need to contact their administrator to be added to Mattermost.`,
                });

                // Force exit from tool processing loop
                consecutiveFailedAttempts = 999;
                break;
              }

              // Track consecutive failures of the same tool
              if (lastFailedToolName === name) {
                consecutiveFailedAttempts++;
              } else {
                consecutiveFailedAttempts = 1;
                lastFailedToolName = name;
              }

              // If we've failed 2 times on the same tool, force the agent to respond
              if (consecutiveFailedAttempts >= 2) {
                console.warn(
                  `[Agent] Tool ${name} failed ${consecutiveFailedAttempts} times. Forcing final response.`,
                );
                messages.push({
                  role: "user",
                  content: `You have attempted to use ${name} multiple times without success. Based on all the information you've gathered so far, please provide a helpful response to the user explaining what you found (if anything) or what the issue might be. Do not attempt to use ${name} again. Do not just read out the results from the tool but you need to use the data from the tool result to give an informative response and if they are juust tool call args do not read them out you need to call the tool`,
                });
                consecutiveFailedAttempts = 0;
              } else {
                // Provide recovery guidance
                const recoveryPrompt = createErrorRecoveryPrompt(
                  name,
                  errorAnalysis,
                  parsedArgs,
                  discoveredIds,
                );

                if (recoveryPrompt) {
                  messages.push({
                    role: "user",
                    content: recoveryPrompt,
                  });
                  console.log(
                    `[Agent] Tool ${name} failed with ${errorAnalysis.errorType}. Providing recovery guidance.`,
                  );
                } else {
                  messages.push({
                    role: "user",
                    content: `The tool encountered an error. Please analyze the error and provide the best response you can based on the information available.`,
                  });
                  console.log(
                    `[Agent] Tool ${name} failed with non-recoverable error.`,
                  );
                }
              }
            }
          } catch (error: any) {
            console.error(`[Agent] Tool execution error:`, error);

            // EXTRACT THE REAL ERROR (Unwrap the nested JSON)
            let errorMessage = error.message || "Unknown error";
            try {
              if (
                errorMessage.includes("Access Denied") ||
                errorMessage.includes("permission")
              ) {
                const cleanMatch =
                  errorMessage.match(/Access Denied:[^"]+/);
                if (cleanMatch) errorMessage = cleanMatch[0];
              } else if (errorMessage.includes("{")) {
                const parsed = JSON.parse(
                  errorMessage.substring(errorMessage.indexOf("{")),
                );
                if (parsed.error?.message) {
                  const inner = JSON.parse(parsed.error.message);
                  errorMessage = inner.error || parsed.error.message;
                }
              }
            } catch (e) {
              /* If parsing fails, use original errorMessage */
            }

            messages.push({
              role: "tool",
              tool_call_id: callId,
              name: name,
              content: JSON.stringify({
                error: "Tool execution failed",
                details: errorMessage,
              }),
            });

            // HANDLE SPECIFIC PERMISSION ERRORS
            if (
              errorMessage.toLowerCase().includes("access denied") ||
              errorMessage.toLowerCase().includes("permission")
            ) {
              messages.push({
                role: "user",
                content: `SYSTEM ALERT: The tool execution failed due to an authorization restriction on the user's account (${parsedArgs.userEmail}).

          ERROR DETAILS: "${errorMessage}"
          
          CRITICAL INSTRUCTION FOR YOUR RESPONSE:
          1. Speak directly to the user about THEIR account status.
          2. STOP saying "I don't have permission". instead say "You do not have permission".
          3. Explicitly state: "Your account (${parsedArgs.userEmail}) lacks the necessary permissions to read content in this channel."
          4. Do not retry. Advise them to contact an administrator.`,
              });
              break;
            }
          }
        }
      }
    }

    if (loopCount >= MAX_LOOPS) {
      console.warn(`[Agent] Reached maximum loop count (${MAX_LOOPS})`);
      messages.push({
        role: "user",
        content: `You must now provide a final response to the user.

Requirements:
1. Use only the information you've gathered from successful tool calls
3. Organize information logically
4. DO NOT mention tools, functions, or technical processes
5. DO NOT apologize excessively
6. Do not just read out the results from the tool but you need to use the data from the tool result to give an informative response and if they are juust tool call args do not read them out you need to call the tool

Provide your final formatted response now.`,
      });

      // One final attempt to get a response
      const finalResponse = await gateway.run({
        provider: "openai",
        endpoint: "chat/completions",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${agent.env.OPENAI_API_KEY}`,
        },
        query: {
          model: "gpt-4o",
          messages: messages,
          tools: [],
          tool_choice: "none",
          max_tokens: 1000,
        },
      });

      const finalResult = await finalResponse.json();
      if (finalResult.choices && finalResult.choices[0]?.message?.content) {
        messages.push({
          role: "assistant",
          content: finalResult.choices[0].message.content,
        });
      }
    }

    // Extract final answer from the last assistant message
    const finalAssistantMessage = messages
      .filter(
        (m) =>
          m.role === "assistant" &&
          m.content &&
          m.content.trim().length > 0,
      )
      .pop();

    console.log("Messages: ", finalAssistantMessage);

    let finalAnswer =
      finalAssistantMessage?.content ||
      "I apologize, but I was unable to complete your request. Please try rephrasing or provide more details.";

    return Response.json({
      status: "success",
      answer: finalAnswer,
      debug: {
        loops: loopCount,
        toolExecutions: toolExecutionHistory.size,
        successfulCalls: successfulToolCalls.size,
      },
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
