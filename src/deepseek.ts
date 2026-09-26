/**
 * Chat client for DeepSeek, which is OpenAI-shaped.
 *
 * The API advertises one fast model, `deepseek-flash`; "DeepSeek V4.1 Flash" is
 * the same model under a marketing name, and the unadvertised `deepseek-v4.1*`
 * aliases are rejected. Thinking is switched off because the agent loop is a
 * short tool hand-off: with it on, every assistant turn has to replay a
 * `reasoning_content` field or the API answers 400.
 */

const CHAT_API = "https://api.deepseek.com/v1/chat/completions";

export const DEEPSEEK_MODEL = "deepseek-flash";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ChatReply {
  content: string | null;
  toolCalls: ToolCall[];
}

export async function chatWithTools(
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolSchema[],
  userId: string,
  toolChoice: "auto" | "none" = "auto",
): Promise<ChatReply> {
  const body = JSON.stringify({
    model: DEEPSEEK_MODEL,
    messages,
    tools,
    tool_choice: toolChoice,
    thinking: { type: "disabled" },
    temperature: 0.2,
    // A run_code program is written inside the tool call's arguments, so this
    // also caps how long a program can be before its JSON is cut off.
    max_tokens: 4000,
    user_id: userId,
  });

  // A turn or two of the loop failing is worth retrying; a voice call has no
  // patience for a longer backoff than this.
  const delays = [0, 400, 900];
  let lastError = "";

  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      const response = await fetch(CHAT_API, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      });

      if (response.ok) {
        const payload = (await response.json()) as {
          choices?: {
            message?: {
              content?: string | null;
              tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        };

        const message = payload.choices?.[0]?.message;
        const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
          .filter((call) => call.function?.name)
          .map((call) => ({
            id: call.id ?? `call_${Math.random().toString(36).slice(2)}`,
            name: call.function?.name as string,
            arguments: call.function?.arguments ?? "{}",
          }));

        return { content: message?.content ?? null, toolCalls };
      }

      lastError = `deepseek ${response.status}: ${(await response.text()).slice(0, 300)}`;
      // 4xx other than rate limiting will not improve on a retry.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError);
}
