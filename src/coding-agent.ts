/**
 * Coding chat: a separate Durable Object from the voice agent.
 *
 * It is-a AIChatAgent (Agents SDK chat batteries). It is not the voice agent
 * and does not share VoiceAgent's ChatStore or GPT-Live socket.
 */
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type GenerateTextOnFinishCallback, type ToolSet } from "ai";
import type { Env } from "./env";

const SYSTEM = `You are Ailobang's coding chat. Help write, read, and debug code.
Be direct. Prefer working snippets over essays. Ask only when a missing fact
blocks a correct answer. Do not speak as the voice agent.`;

/** Same advertised flash model the voice harness uses. */
const DEEPSEEK_CHAT_MODEL = "deepseek-flash";

export class CodingAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 200;
  waitForMcpConnections = false;

  async onChatMessage(onFinish: GenerateTextOnFinishCallback<ToolSet>, options?: { abortSignal?: AbortSignal }) {
    const deepseek = createOpenAI({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: this.env.DEEPSEEK_API_KEY,
    });

    const result = streamText({
      model: deepseek(DEEPSEEK_CHAT_MODEL),
      system: SYSTEM,
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      onFinish,
    });

    return result.toUIMessageStreamResponse();
  }
}
