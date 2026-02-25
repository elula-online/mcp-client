import type { Env } from "../types";
import { sendPusherBatchEvent } from "../services/pusherHandler";
import type { ExecutionContext } from "@cloudflare/workers-types";

export async function streamAndNotifyPusher(
  gateway: any,
  params: any,
  env: Env,
  channel: string,
  model_used: string,
  ctx: ExecutionContext
): Promise<{
  content: string;
  usage: any;
  logId: string;
  toolCalls: any[];
  chunkCount: number;
}> {

  const streamParams = {
    ...params,
    query: {
      ...params.query,
      stream: true,
      stream_options: { include_usage: true },
    },
  };

  const response = await gateway.run(streamParams);

  if (!response.body) throw new Error("No response body for stream");

  const logId = response.headers.get("cf-aig-log-id") || "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let fullContent = "";
  let usage: any = null;
  let buffer = "";
  let chunkCount = 0;
  let batch: any[] = [];
  const BATCH_SIZE = 5;

  const toolCalls: any[] = [];
  const toolCallMap: Record<number, any> = {}; // Keyed by index to correctly correlate streamed chunks

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const json = JSON.parse(dataStr);

          // Capture usage when it arrives
          if (json.usage) usage = json.usage;

          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          // Handle text content streaming
          if (delta.content) {
            fullContent += delta.content;
            chunkCount++;

            batch.push({
              type: "universal.stream",
              chunk_count: chunkCount,
              timestamp: Date.now() / 1000,
              message: {
                response: delta.content,
                model: params.query.model,
              },
            });

            if (batch.length >= BATCH_SIZE) {
              ctx.waitUntil(
                sendPusherBatchEvent(env, batch.splice(0, BATCH_SIZE), channel)
              );
            }
          }

          // Handle tool call delta chunks
          if (delta.tool_calls) {
            for (const toolDelta of delta.tool_calls) {
              const index = toolDelta.index; // OpenAI streams use 'index' to correlate chunks

              // Initialize the tool call object on first sight of this index
              if (!toolCallMap[index]) {
                toolCallMap[index] = {
                  id: toolDelta.id || `call_${index}_${Date.now()}`,
                  type: "function",
                  function: {
                    name: toolDelta.function?.name || "",
                    arguments: "",
                  },
                };
              }

              // Set name (usually arrives in one chunk, not appended)
              if (toolDelta.function?.name) {
                toolCallMap[index].function.name = toolDelta.function.name;
              }

              // Append argument chunks (this is what streams heavily)
              if (toolDelta.function?.arguments) {
                toolCallMap[index].function.arguments += toolDelta.function.arguments;
              }
            }
          }
        } catch {
          // Ignore incomplete JSON chunks in the stream
        }
      }
    }

    // Flush any remaining batched chunks
    if (batch.length > 0) {
      ctx.waitUntil(sendPusherBatchEvent(env, batch, channel));
    }

    // Convert toolCallMap to the final array expected by ToolExecutor
    Object.values(toolCallMap).forEach((tc) => toolCalls.push(tc));

  } catch (err) {
    console.error("Streaming error:", err);
  }

  return {
    content: fullContent,
    usage,
    logId,
    toolCalls,
    chunkCount,
  };
}