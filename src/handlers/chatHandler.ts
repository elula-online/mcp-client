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
  let total_streamed_chunks = 0;

  let model_used;
  let channel = "";
  let thread_id = "";
  let webhook_url = "";
  let logId = "";
  let prompt_id = "";

  try {
    const body = (await request.json()) as any;

    const email = body.email;
    thread_id = body.thread_id || "default";
    webhook_url = body.webhook_url || "";
    prompt_id = body.prompt_id || "";

    let messages = body.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      if (body.prompt) {
        messages = [{ role: "user", content: body.prompt }];
      } else {
        return Response.json({ error: "No messages provided" }, { status: 400 });
      }
    }

    channel = `chat.${thread_id}`;
    if (body.model) model_used = body.model;

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

    // Initialize services
    const toolExecutor = new ToolExecutor();
    const errorRecovery = new ErrorRecoveryService();
    const validator = new ResponseValidator(); // Keeping if needed for future utilities
    const dataCache = getGlobalCache();
    const dataFetcher = new DataFetcher();

    // MCP Connection Check
    const servers = await agent.mcp.listServers();
    if (!servers.some((s: any) => s.name === "SystemMCPportal" && s.id)) {
      await initializeMcpConnection(agent);
    }

    // Fetch tools
    const mcpToolsResult = await agent.mcp.getAITools();
    const gateway = agent.env.AI.gateway(agent.env.GATEWAY_ID);
    const toolExecutorMap: Record<string, any> = {};

    const tools = Object.entries(mcpToolsResult).map(([toolKey, tool]: any) => {
      toolExecutorMap[toolKey] = tool;
      return {
        type: "function",
        function: {
          name: toolKey,
          description: tool.description,
          parameters: tool.inputSchema.jsonSchema,
        },
      };
    });

    // Populate cache for RAG (Mattermost-specific)
    await dataFetcher.refreshIfNeeded(toolExecutorMap, email, dataCache);
    const cachePopulated = !dataCache.isEmpty();

    const enhancedSystemPrompt = cachePopulated
      ? `${systemPrompt}\n\n## AVAILABLE RESOURCES\n${dataCache.formatCompactChannelsForLLM()}\n${dataCache.formatCompactUsersForLLM()}`
      : systemPrompt;

    // Initialize State
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

    // -- Main Agent Loop (single streaming call per iteration, mirrors GitLab pattern) --
    while (state.canContinue()) {
      state.incrementLoop();
      const shouldForceAnswer = state.loopCount >= 6;
      const sanitizedMessages = sanitizeForOpenAI(state.messages);

      // SINGLE NATIVE STREAMING CALL PER LOOP
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
            messages: sanitizedMessages,
            tools: shouldForceAnswer ? [] : tools,
            tool_choice: shouldForceAnswer ? "none" : "auto",
          },
        },
        agent.env,
        channel,
        model_used,
        ctx,
      );

      logId = streamResult.logId;
      total_streamed_chunks += streamResult.chunkCount;

      accumulated_usage.prompt_tokens += streamResult.usage?.prompt_tokens || 0;
      accumulated_usage.completion_tokens += streamResult.usage?.completion_tokens || 0;
      accumulated_usage.total_tokens += streamResult.usage?.total_tokens || 0;

      // Case: Tool Calls
      if (streamResult.toolCalls?.length > 0) {
        state.addMessage({
          role: "assistant",
          content: streamResult.content || "", // Include any text streamed before tool calls
          tool_calls: streamResult.toolCalls,
        });

        state.transitionTo(AgentLoopState.EXECUTING_TOOLS);

        const toolResults = await toolExecutor.executeToolCalls(
          streamResult.toolCalls,
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
                streamResult.toolCalls.find(
                  (tc: any) => tc.id === res.toolCallId,
                )?.function?.arguments || {},
            });
            if (recoveryAction.message) state.addMessage(recoveryAction.message);
          }
        }

        if (state.state !== AgentLoopState.FAILED) {
          state.transitionTo(AgentLoopState.AWAITING_LLM_RESPONSE);
        }
      }
      // Case: Final Text Response
      else {
        state.addMessage({
          role: "assistant",
          content: streamResult.content,
        });
        state.transitionTo(AgentLoopState.COMPLETED);
        break; // Exit the loop entirely
      }
    }

    ctx.waitUntil(
      sendPusherBatchEvent(agent.env, [
        {
          type: "universal.done",
          total_chunks: total_streamed_chunks,
          timestamp: Date.now() / 1000,
        },
      ], channel)
    );

    // Webhook logging
    if (webhook_url) {
      ctx.waitUntil(
        fetch(webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            logid: logId,
            response: state.getFinalAnswer(),
            prompt_tokens: accumulated_usage.prompt_tokens,
            completion_tokens: accumulated_usage.completion_tokens,
            total_tokens: accumulated_usage.total_tokens,
            model_used: "gpt-5-nano",
            uuid: prompt_id,
            type: "streaming.response",
            debug: state.getMetrics(),
          }),
        })
          .then(async (res) => {
            if (!res.ok)
              console.error("[Webhook] Failed:", res.status, await res.text());
          })
          .catch((e) => console.error("Webhook fail", e)),
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