/**
 * Coding chat: a separate Durable Object from the voice agent.
 *
 * It is-a AIChatAgent. It has-a ConnectorHarness (same Composio MCP + Telegram
 * DO + Exa as voice). It is not VoiceAgent and does not share ChatStore.
 */
import { AIChatAgent } from "@cloudflare/ai-chat";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { GenerateTextOnFinishCallback, ToolSet } from "ai";
import { CODE_GUIDANCE, CODE_TIMEOUT_MS } from "./code-tool";
import { createToolRouterSession } from "./composio";
import type { Env } from "./env";
import { BANK_GUIDANCE, ConnectorHarness } from "./harness";
import { McpClient } from "./mcp";
import { PlaidBanks, plaidConfig } from "./plaid";

const SITE_ORIGIN = "https://ailobang.com";
const TOOL_ROUTER_KEY = "toolRouterSession";

const CODING_SYSTEM = `## Coding chat with connected accounts
You are Ailobang's coding chat. Help write, read, and debug code, and use the
caller's connected accounts when the question needs their data or an action
there. You may use markdown and code fences. Do not pretend to be the voice call.

## Connected accounts
The tools below act on the caller's own connected accounts: Google (Gmail, Drive,
Calendar, Sheets, Docs, Photos, Contacts, Tasks), Telegram, Reddit, LinkedIn,
Slack, Notion, Discord, Google Maps, Cursor, and the bank accounts they linked
through Plaid.

That list is what the tools can do, not what is connected. Which accounts are
connected is only ever known from a tool's own answer: never tell the caller an
account is or is not connected from memory, never list their connections without
having asked, and when a tool reports that something is not connected, that
report is the answer rather than a reason to guess.

${BANK_GUIDANCE}

## Telegram
The Telegram tools act on the caller's own Telegram account — not a bot, and not
through Composio. Use these tools directly for anything about Telegram.

Reading is forward-only from connect time.

Sending is one call: telegram_send with the person's name or @username and the
exact text. It sends straight away; asking is the go-ahead, so do not ask the
caller to confirm first. If several people fit a name it sends nothing and lists
them, so ask which. A name is enough; never say a handle is required. Never say
not found without having looked it up.

## Web search
web_search is for live world facts and docs. Prefer an account tool for the
caller's own data.

## How to use the tools
1. COMPOSIO_SEARCH_TOOLS with the request as the use case. Call it once per
   request: put every independent lookup in its queries array.
2. COMPOSIO_GET_TOOL_SCHEMAS for those slugs.
3. COMPOSIO_MULTI_EXECUTE_TOOL to run them.
Never invent a tool slug. If the needed account is not connected, say so.

${CODE_GUIDANCE}

## Return
Lead with the answer. Use code blocks for code. Report only what tools confirmed.`;

export class CodingAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 200;
  waitForMcpConnections = false;
  private harness: ConnectorHarness | null = null;

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal },
  ) {
    const transcript = this.messages
      .map((message) => {
        const text = (message.parts ?? [])
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("");
        if (!text) return "";
        return `${message.role}: ${text}`;
      })
      .filter(Boolean)
      .join("\n");

    const harness = await this.getHarness();
    const result = await harness.run(transcript, () => {}, options?.abortSignal, {
      system: CODING_SYSTEM,
      maxAnswerChars: 8000,
    });

    return new Response(result.text, { headers: { "Content-Type": "text/plain;charset=utf-8" } });
  }

  private async getHarness(): Promise<ConnectorHarness> {
    if (this.harness) return this.harness;

    const session = await this.toolRouterSession();
    const plaid = plaidConfig(this.env);
    const harness = new ConnectorHarness(
      new McpClient(session.mcpUrl, this.env.COMPOSIO_API_KEY),
      this.env.DEEPSEEK_API_KEY,
      this.env.EXA_API_KEY,
      this.name,
      this.env.TELEGRAM_SESSION.get(this.env.TELEGRAM_SESSION.idFromName(this.name)),
      new DynamicWorkerExecutor({ loader: this.env.LOADER, timeout: CODE_TIMEOUT_MS }),
      plaid ? new PlaidBanks(plaid, this.env.DB, this.name) : null,
    );
    await harness.warmUp();
    this.harness = harness;
    return harness;
  }

  private async toolRouterSession(): Promise<{ sessionId: string; mcpUrl: string }> {
    const cached = await this.ctx.storage.get<{ sessionId: string; mcpUrl: string }>(TOOL_ROUTER_KEY);
    if (cached?.mcpUrl) return cached;

    const created = await createToolRouterSession(
      this.env.COMPOSIO_API_KEY,
      this.name,
      `${SITE_ORIGIN}/connect/return`,
    );
    await this.ctx.storage.put(TOOL_ROUTER_KEY, created);
    return created;
  }
}
