import type { Agent } from "agents";
import type { Env, Message } from "../types";
import systemPrompt from "../systemPrompt";
import { initializeMcpConnection } from "./mcpConnection";
import { AgentState, AgentLoopState } from "../state/AgentState";
import { ToolExecutor } from "../services/ToolExecutor";
import { ErrorRecoveryService } from "../services/ErrorRecoveryService";
import { ResponseValidator } from "../services/ResponseValidator";
import { DataFetcher } from "../services/DataFetcher";
import { getGlobalCache } from "./cacheHandler";
import type { AgentContext } from "../models/ToolResult";
import { sendPusherBatchEvent } from "../services/pusherHandler";
import { streamAndNotifyPusher } from "./streamAndNotifyPusher";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { sanitizeForOpenAI } from "../services/sanitizeForOpenAI";

export async function handleChatRequest(
  request: Request,
  agent: Agent<Env, never>,
  ctx: ExecutionContext,
): Promise<Response> {
  let accumulated_usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let model_used;
  let channel = "";
  let thread_id = "";
  let webhook_url = "";
  let logId = "";
  let prompt_id = "";

  try {
    const body = (await request.json()) as any;
    console.log("received request");

    const email = body.email;
    thread_id = body.thread_id || "default";
    webhook_url = body.webhook_url || "";
    prompt_id = body.prompt_id || "";

    let messages = body.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      if (body.prompt) {
        messages = [{ role: "user", content: body.prompt }];
      } else {
        return Response.json(
          { error: "No messages provided" },
          { status: 400 },
        );
      }
    }

    channel = `chat.${thread_id}`;
    if (body.model) model_used = body.model;
    console.log("model: ", model_used);

    // Initialize services
    const toolExecutor = new ToolExecutor();
    const errorRecovery = new ErrorRecoveryService();
    const validator = new ResponseValidator();
    const dataCache = getGlobalCache();
    const dataFetcher = new DataFetcher();

    // 1. Pusher: Initializing
    // ctx.waitUntil(sendPusherBatchEvent(agent.env, [{
    //     type: 'universal.status',
    //     status: 'initializing',
    //     message: 'Connecting to Mattermost tools...',
    //     timestamp: Date.now() / 1000
    // }], channel));

    ctx.waitUntil(
      sendPusherBatchEvent(
        agent.env,
        [
          {
            type: "universal.start",
            model: model_used,
            timestamp: Date.now() / 1000,
          },
        ],
        channel,
      ),
    );

    // MCP Connection Check
    const servers = await agent.mcp.listServers();
    const connected = servers.some(
      (s: any) => s.name === "SystemMCPportal" && s.id,
    );
    if (!connected) await initializeMcpConnection(agent);

    // Fetch tools
    let mcpToolsResult = await agent.mcp.getAITools();
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

    // Populate cache for RAG
    await dataFetcher.refreshIfNeeded(toolExecutorMap, email, dataCache);
    const cachePopulated = !dataCache.isEmpty();

    const enhancedSystemPrompt = cachePopulated
      ? `${systemPrompt}\n\n## AVAILABLE RESOURCES\n${dataCache.formatCompactChannelsForLLM()}\n${dataCache.formatCompactUsersForLLM()}`
      : systemPrompt;

    // 2. Initialize State
    const state = new AgentState(enhancedSystemPrompt, messages);
    state.transitionTo(AgentLoopState.AWAITING_LLM_RESPONSE);

    const executionContext: AgentContext = {
      toolExecutorMap,
      userEmail: email,
      discoveredIds: state.discoveredIds,
      toolExecutionHistory: state.toolExecutionHistory,
      successfulToolCalls: state.successfulToolCalls,
      cache: dataCache,
    };

    // -- Main Loop --
    while (state.canContinue()) {
      state.incrementLoop();
      // Reduced loop limit to 6 to prevent expensive infinite loops
      const shouldForceAnswer = state.loopCount >= 6;

      // ctx.waitUntil(
      //   sendPusherBatchEvent(
      //     agent.env,
      //     [
      //       {
      //         type: "universal.status",
      //         status: "thinking",
      //         message:
      //           state.loopCount > 1
      //             ? `Thinking (Step ${state.loopCount})...`
      //             : "Analyzing request...",
      //         timestamp: Date.now() / 1000,
      //       },
      //     ],
      //     channel,
      //   ),
      // );

      // Sanitize messages right before sending
      const sanitizedMessages = sanitizeForOpenAI(state.messages);

      const response = await gateway.run({
        provider: "openai",
        endpoint: "chat/completions",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${agent.env.OPENAI_API_KEY}`,
          "cf-aig-event-id": prompt_id || "",
          "cf-aig-metadata": JSON.stringify({ backend_uuid: prompt_id }),
        },
        query: {
          model: "gpt-5-nano",
          messages: sanitizedMessages, // Use sanitized version
          tools: shouldForceAnswer ? [] : tools,
          tool_choice: shouldForceAnswer ? "none" : "auto",
        },
      });

      const result = await response.json();

      // Handle Gateway/OpenAI Errors Gracefully
      if (result.error) {
        console.error("OpenAI Error:", result.error);
        throw new Error(`OpenAI Provider Error: ${result.error.message}`);
      }

      if (result.usage) {
        accumulated_usage.prompt_tokens += result.usage.prompt_tokens || 0;
        accumulated_usage.completion_tokens +=
          result.usage.completion_tokens || 0;
        accumulated_usage.total_tokens += result.usage.total_tokens || 0;
      }

      const choice = result.choices?.[0];
      const toolCalls = choice?.message?.tool_calls || [];
      const assistantContent = choice?.message?.content || "";

      // Case: Text Response (Success)
      if (toolCalls.length === 0 && assistantContent) {
        // Optional: Validate response quality here
        // state.addMessage({ role: "assistant", content: assistantContent });
        // state.transitionTo(AgentLoopState.COMPLETED);
        break;
      }

      // Case: Tool Execution
      if (toolCalls.length > 0) {
        state.transitionTo(AgentLoopState.EXECUTING_TOOLS);
        state.addMessage({
          role: "assistant",
          content: assistantContent || "",
          tool_calls: toolCalls,
        });

        const toolNames = toolCalls.map((t: any) => t.function.name).join(", ");
        // ctx.waitUntil(
        //   sendPusherBatchEvent(
        //     agent.env,
        //     [
        //       {
        //         type: "universal.status",
        //         status: "tool_use",
        //         message: `Using tools: ${toolNames}`,
        //         timestamp: Date.now() / 1000,
        //       },
        //     ],
        //     channel,
        //   ),
        // );

        const toolResults = await toolExecutor.executeToolCalls(
          toolCalls,
          executionContext,
        );

        for (const res of toolResults) {
          state.addMessage({
            role: "tool",
            tool_call_id: res.toolCallId,
            name: res.toolName,
            content: res.data || JSON.stringify(res.error),
          });

          if (res.status === "success") {
            state.markProgress();
          } else {
            // Critical: Use Recovery Service
            state.recordToolFailure(res.toolName);
            if (errorRecovery.isCriticalError(res)) {
              state.transitionTo(AgentLoopState.FAILED);
              break;
            }
            const recoveryAction = errorRecovery.getRecoveryAction(res, {
              discoveredIds: state.discoveredIds,
              consecutiveFailures: state.consecutiveFailures,
              userEmail: email,
              originalArgs:
                toolCalls.find((tc: any) => tc.id === result.toolCallId)
                  ?.arguments || {},
            });
            if (recoveryAction.message)
              state.addMessage(recoveryAction.message);
          }
        }
        state.transitionTo(AgentLoopState.AWAITING_LLM_RESPONSE);
      }
      // Case: Empty Response (Stuck)
      else if (!assistantContent) {
        state.addMessage({
          role: "user",
          content: "Please continue and provide an answer.",
        });
      }
    }

    // --- STREAMING FINAL RESPONSE ---
    if (state.state !== AgentLoopState.COMPLETED) {
      state.addMessage(validator.createFinalResponsePrompt());

      // Sanitize messages for the final stream as well
      const finalSanitizedMessages = sanitizeForOpenAI(state.messages);

      const streamResult = await streamAndNotifyPusher(
        gateway,
        {
          provider: "openai",
          endpoint: "chat/completions",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${agent.env.OPENAI_API_KEY}`,
            "cf-aig-event-id": prompt_id || "",
            "cf-aig-metadata": JSON.stringify({ backend_uuid: prompt_id }),
          },
          query: {
            model: "gpt-5-nano",
            messages: finalSanitizedMessages, // Use sanitized version
            tools: [],
            tool_choice: "none",
          },
        },
        agent.env,
        channel,
        model_used,
        ctx,
      );

      logId = streamResult.logId;

      if (streamResult.content) {
        state.addMessage({ role: "assistant", content: streamResult.content });
        state.transitionTo(AgentLoopState.COMPLETED);
      }

      if (streamResult.usage) {
        accumulated_usage.prompt_tokens +=
          streamResult.usage.prompt_tokens || 0;
        accumulated_usage.completion_tokens +=
          streamResult.usage.completion_tokens || 0;
        accumulated_usage.total_tokens += streamResult.usage.total_tokens || 0;
      }

      state.transitionTo(AgentLoopState.COMPLETED);
    }

    // 4. Webhook Logging
    if (webhook_url) {
      ctx.waitUntil(
        fetch(webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            logid: logId || "",
            prompt_tokens: accumulated_usage.prompt_tokens,
            completion_tokens: accumulated_usage.completion_tokens,
            total_tokens: accumulated_usage.total_tokens,
            model_used: 'gpt-5-nano',
            uuid: prompt_id,
            response: state.getFinalAnswer(),
            type: "streaming.response",
            debug: state.getMetrics(),
          }),
        }).catch((e) => console.error("Webhook fail", e)),
      );
    }

    return Response.json({
      status: "success",
      answer: state.getFinalAnswer(),
      debug: state.getMetrics(),
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
