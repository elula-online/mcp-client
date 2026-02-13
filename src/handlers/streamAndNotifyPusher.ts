import type { Env, Message } from "../types";
import { sendPusherBatchEvent } from "../services/pusherHandler";

export async function streamAndNotifyPusher(
  gateway: any,
  params: any,
  env: Env,
  channel: string,
  ctx: ExecutionContext
): Promise<{ content: string; usage: any }> {

  const streamParams = {
    ...params,
    query: {
      ...params.query,
      stream: true,
      stream_options: { include_usage: true }, 
    },
  };

  const response = await gateway.run(streamParams);

  if (!response.body) {
    throw new Error("No response body for stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  
  let fullContent = "";
  let buffer = "";
  let usage = null;
  let chunkCount = 0;
  let batch: any[] = [];
  const BATCH_SIZE = 5; 

  // Send "Start" event
  ctx.waitUntil(sendPusherBatchEvent(env, [{
    type: 'universal.start',
    model: params.query.model,
    timestamp: Date.now() / 1000
  }], channel));

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunkText = decoder.decode(value, { stream: true });
      buffer += chunkText;
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; 

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const json = JSON.parse(dataStr);

          const delta = json.choices?.[0]?.delta?.content || "";
          
          if (json.usage) {
            usage = json.usage;
          }

          if (delta) {
            fullContent += delta;
            chunkCount++;

            batch.push({
              type: 'universal.stream',
              chunk_count: chunkCount,
              timestamp: Date.now() / 1000,
              message: {
                response: delta,
                model: params.query.model
              }
            });

            if (batch.length >= BATCH_SIZE) {
              const currentBatch = batch.splice(0, BATCH_SIZE);
              ctx.waitUntil(sendPusherBatchEvent(env, currentBatch, channel));
            }
          }
        } catch (e) {
          // console.warn("Error parsing stream line", e);
        }
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      ctx.waitUntil(sendPusherBatchEvent(env, batch, channel));
    }

    ctx.waitUntil(sendPusherBatchEvent(env, [{
      type: 'universal.done',
      total_chunks: chunkCount,
      timestamp: Date.now() / 1000
    }], channel));

  } catch (err) {
    console.error("Streaming error:", err);
  }

  return { content: fullContent, usage };
}