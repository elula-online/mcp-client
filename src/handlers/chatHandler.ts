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

/**
 * Handle chat endpoint - main agent loop with improved architecture
 */
export async function handleChatRequest(
  request: Request,
  agent: Agent<Env, never>,
  ctx: ExecutionContext
): Promise<Response> {
  let accumulated_usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let model_used = "gpt-5-nano"; // Defaulting to gpt-4 to match production config
  let channel = "";
  let thread_id = "";
  let webhook_url = "";

  try {
    const body = (await request.json()) as any;
    
    const email = body.email;
    const thread_id = body.thread_id || "default";
    const webhook_url = body.webhook_url || "";
    const messages = body.messages || [];
    
    // Get the last user message as the "current prompt" for the validator/state
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    const currentPrompt = lastUserMessage?.content || "";

    channel = `chat.${thread_id}`;
    if (body.model) model_used = body.model;

    // Initialize services
    const toolExecutor = new ToolExecutor();
    const validator = new ResponseValidator();
    const dataCache = getGlobalCache();
    const dataFetcher = new DataFetcher();

    // 1. Pusher: Initializing
    ctx.waitUntil(sendPusherBatchEvent(agent.env, [{
        type: 'universal.status',
        status: 'initializing',
        message: 'Connecting to Mattermost tools...',
        timestamp: Date.now() / 1000
    }], channel));

    // MCP Connection Check
    const servers = await agent.mcp.listServers();
    const connected = servers.some((s: any) => s.name === "SystemMCPportal" && s.id);
    if (!connected) await initializeMcpConnection(agent);

    // Fetch tools
    let mcpToolsResult = await agent.mcp.getAITools();
    const gateway = agent.env.AI.gateway(agent.env.GATEWAY_ID);
    const toolExecutorMap: Record<string, any> = {};

    const tools = Object.entries(mcpToolsResult).map(([toolKey, tool]: [string, any]) => {
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

    // Populate cache for RAG
    await dataFetcher.refreshIfNeeded(toolExecutorMap, email, dataCache);
    const cachePopulated = !dataCache.isEmpty();

    const enhancedSystemPrompt = cachePopulated
      ? `${systemPrompt}\n\n## AVAILABLE RESOURCES\n${dataCache.formatCompactChannelsForLLM()}\n${dataCache.formatCompactUsersForLLM()}`
      : systemPrompt;

    // 2. Initialize State with full message history
    // Assuming AgentState constructor accepts (systemPrompt, initialMessagesArray)
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

    // --- Main Loop ---
    while (state.canContinue()) {
      state.incrementLoop();
      const shouldForceAnswer = state.loopCount >= 9;

      ctx.waitUntil(sendPusherBatchEvent(agent.env, [{
        type: 'universal.status',
        status: 'thinking',
        message: state.loopCount > 1 ? `Thinking (Step ${state.loopCount})...` : 'Analyzing request...',
        timestamp: Date.now() / 1000
      }], channel));

      // Standard Non-Streaming Call for Tool Decision
      const response = await gateway.run({
        provider: "openai",
        endpoint: "chat/completions",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${agent.env.OPENAI_API_KEY}`,
        },
        query: {
          model: model_used,
          messages: state.messages,
          tools: shouldForceAnswer ? [] : tools,
          tool_choice: shouldForceAnswer ? "none" : "auto",
        },
      });

      const result = await response.json();
      
      if (result.usage) {
        accumulated_usage.prompt_tokens += result.usage.prompt_tokens || 0;
        accumulated_usage.completion_tokens += result.usage.completion_tokens || 0;
        accumulated_usage.total_tokens += result.usage.total_tokens || 0;
      }

      const choice = result.choices?.[0];
      const toolCalls = choice?.message?.tool_calls || [];
      const assistantContent = choice?.message?.content || "";

      if (toolCalls.length === 0 && assistantContent) {
        state.addMessage({ role: "assistant", content: assistantContent });
        state.transitionTo(AgentLoopState.COMPLETED);
        break;
      }
      
      if (toolCalls.length > 0) {
        state.transitionTo(AgentLoopState.EXECUTING_TOOLS);
        state.addMessage({ role: "assistant", content: assistantContent || "", tool_calls: toolCalls });

        const toolNames = toolCalls.map((t: any) => t.function.name).join(", ");
        ctx.waitUntil(sendPusherBatchEvent(agent.env, [{
            type: 'universal.status',
            status: 'tool_use',
            message: `Using tools: ${toolNames}`,
            timestamp: Date.now() / 1000
        }], channel));

        const toolResults = await toolExecutor.executeToolCalls(toolCalls, executionContext);
        
        for (const res of toolResults) {
            state.addMessage({
                role: "tool",
                tool_call_id: res.toolCallId,
                name: res.toolName,
                content: res.data || JSON.stringify(res.error)
            });
            if (res.status === 'success') state.markProgress();
        }
        state.transitionTo(AgentLoopState.AWAITING_LLM_RESPONSE);
      }
    }

    // --- STREAMING FINAL RESPONSE ---
    if (state.state !== AgentLoopState.COMPLETED) {
      state.addMessage(validator.createFinalResponsePrompt());

      const streamResult = await streamAndNotifyPusher(
        gateway,
        {
          provider: "openai",
          endpoint: "chat/completions",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${agent.env.OPENAI_API_KEY}`,
          },
          query: {
            model: model_used,
            messages: state.messages,
            tools: [],
            tool_choice: "none",
          },
        },
        agent.env,
        channel,
        ctx
      );

      if (streamResult.content) {
        state.addMessage({ role: "assistant", content: streamResult.content });
      }

      if (streamResult.usage) {
        accumulated_usage.prompt_tokens += streamResult.usage.prompt_tokens || 0;
        accumulated_usage.completion_tokens += streamResult.usage.completion_tokens || 0;
        accumulated_usage.total_tokens += streamResult.usage.total_tokens || 0;
      }

      state.transitionTo(AgentLoopState.COMPLETED);
    }

    // 4. Webhook Logging
    if (webhook_url) {
        ctx.waitUntil(fetch(webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                logid: `mm-${Date.now()}`,
                prompt_tokens: accumulated_usage.prompt_tokens,
                completion_tokens: accumulated_usage.completion_tokens,
                total_tokens: accumulated_usage.total_tokens,
                model_used: model_used,
                uuid: thread_id,
                response: state.getFinalAnswer(),
                type: 'agent.response',
                debug: state.getMetrics()
            })
        }).catch(e => console.error("Webhook fail", e)));
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
