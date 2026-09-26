/**
 * The backend "think harness" behind a voice call.
 *
 * GPT-Live handles the spoken conversation and, when a request needs real
 * account data, asks the backend for help (`session.delegation.created`). It
 * sends no task text, so the harness rebuilds intent from the running
 * transcript and works it out with its own model plus the Composio MCP tools
 * for this user's connected accounts.
 *
 * Composio's per-user MCP session exposes meta-tools rather than every app tool,
 * so the loop is: search for the right tool, read its schema, execute it, then
 * hand back one short spoken-friendly answer.
 */

import type { Executor } from "@cloudflare/codemode";
import { CODE_GUIDANCE, CodeToolbox, RUN_CODE, RUN_CODE_TOOL } from "./code-tool";
import { chatWithTools, type ChatMessage, type ToolSchema } from "./deepseek";
import { webSearch } from "./exa";
import type { McpClient, McpTool } from "./mcp";
import { MEMORY_GUIDANCE, MEMORY_TOOL, MemoryToolbox, type MemoryActions } from "./memory/tool";
import type { PlaidActions } from "./plaid";
import { PlaidToolbox, plaidTools } from "./plaid-tools";
import { TELEGRAM_TOOLS, TelegramToolbox, type TelegramActions } from "./telegram-tools";

/** Enough for search -> schema -> execute plus repeats and a summary. A model that
 * searches more than once would otherwise starve the loop of the step it needs to
 * answer, and the caller would hear the fallback. */
const MAX_STEPS = 10;
/** Tool output beyond this is noise for a spoken answer and slows the loop down. */
const MAX_TOOL_CHARS = 6000;
const MAX_ANSWER_CHARS = 1500;
/** Earlier work carried into later runs; past this the oldest requests drop out. */
const MAX_WORKLOG_CHARS = 8000;
const WORKLOG_ARGS_CHARS = 400;
const WORKLOG_OUTPUT_CHARS = 1000;
/** Discovery calls: what they returned is no use to a later request. */
const UNLOGGED_TOOLS = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);

/** Shared with the coding chat, which reaches the same banks. */
export const BANK_GUIDANCE = `## Bank accounts (Plaid)
The plaid_ tools read the bank, card and loan accounts the caller linked through
Plaid. They are not in Composio, so never search Composio for banking; call
them directly. plaid_list_accounts gives every account and its balance.
plaid_transactions finds transactions between two dates, filtered by merchant,
category or account, and adds up what was spent and received: answer "how much"
questions from its totals, never by adding the listed rows. Both are read-only.
Nothing can pay, transfer or move money, so say that if the caller asks. A bank
the tools say needs signing in again is fixed from the Plaid row on the caller's
accounts page.`;

export const SYSTEM_PROMPT = `## Voice conversation context
You are the backend for an assistant in a live voice call. You do not speak:
you return one short, factual result that the voice assistant reads aloud.
Transcripts can contain mistakes, unfinished phrases and corrections. Act on the
caller's latest request, using the earlier context and verified tool results. If
a needed detail is missing, say which detail you still need instead of guessing.

## Act on the first ask
The caller asking is the go-ahead. When they ask you to send, create, write,
share or schedule something, do it now with the tools and report what was done.
Never prepare something and ask them to confirm it, never ask "shall I send
it?", and never answer with a plan of what you are about to do. Ask only when
something you need is genuinely missing or ambiguous: which of several people a
name means, or what a message should say when they gave no hint of it. When they
say "send it" or "go ahead", that is a request to do the thing they asked for
just before, now.

## Earlier in this call
The request can come with a record of what you already did earlier in this
call. Those are real, finished tool results. Never redo anything that record
shows as done: no second document, no second message. Build on it instead, for
example by reusing the link of a document you already created. When the caller
asks whether something happened ("have you sent it?", "is the doc made?"),
answer from that record.

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
through Composio, so Composio has no Telegram toolkit and searching it for one
finds nothing. Use these tools directly for anything about Telegram.

Reading is forward-only. telegram_list_chats shows the chats with something in
them since they connected and telegram_read_messages reads one of them. Nothing
from before the connection exists, so say that rather than implying a longer
history.

Sending is one call: telegram_send with the person's name or @username and the
exact text. It sends straight away; do not ask the caller to confirm first. Say
a message was sent only when telegram_send says it was, and then say who it went
to. When the message should carry something another tool makes (a document's
link, say), make that first and put the real result in the text.

Files go with telegram_send_file, under the same rules: photos, videos, voice
notes, PDFs, spreadsheets, anything up to 20 MB. Pass a download link another
tool returned as url, or text you wrote as content with a filename — a .pdf
filename turns that text into a real PDF, so write the document yourself when
the caller asks for one — and never
paste a link into telegram_send when the caller asked for the file itself.

The caller never has to spell out a handle. Pass the name as they said it — a
first name, a nickname, a full name — and telegram_send resolves it. If several
people fit, it sends nothing and lists them: ask which one they mean rather than
choosing. A person with no @username is still someone to send to, so never tell
the caller a handle is needed. telegram_find_contact is for questions about who
someone is, not a step before sending. Never tell the caller a name was not found
without having looked it up.

## Web search
web_search looks things up on the live internet. Use it for anything about the
world outside the caller's accounts — news, current events, prices, releases,
documentation, facts that may have changed since you were trained. Do not use it
for the caller's own data, and prefer an account tool whenever one answers the
question. If a search returns nothing useful, say so rather than guessing.

## How to use the tools
1. COMPOSIO_SEARCH_TOOLS with the caller's request as the use case, to find the
   right tool slugs. Call it once per request: put every independent lookup in
   its queries array instead of searching again.
2. COMPOSIO_GET_TOOL_SCHEMAS for those slugs, to get the exact arguments.
3. COMPOSIO_MULTI_EXECUTE_TOOL to run them, once, with every tool it needs.
Never invent a tool slug or an argument value you were not given. If the caller
has not connected the account a request needs, say so plainly.

${CODE_GUIDANCE}

${MEMORY_GUIDANCE}

## Return the result
Answer in at most 60 words of plain conversational text, with no markdown, no
lists and no URLs: it is read aloud by a voice model. Lead with the answer.
Report only facts the tools confirmed, and say when something failed. Never
claim an action succeeded unless a tool result says it did.`;

/** Maps a meta-tool call to something worth showing, and briefly saying, mid-task. */
const PROGRESS_NOTES: Record<string, string> = {
  web_search: "Searching the web.",
  COMPOSIO_SEARCH_TOOLS: "Looking through your connected apps.",
  COMPOSIO_GET_TOOL_SCHEMAS: "Checking how to fetch that.",
  COMPOSIO_MULTI_EXECUTE_TOOL: "Fetching that now.",
  COMPOSIO_REMOTE_WORKBENCH: "Working through that now.",
  COMPOSIO_REMOTE_BASH_TOOL: "Working through that now.",
  COMPOSIO_MANAGE_CONNECTIONS: "Checking your connections.",
  telegram_list_chats: "Looking through your Telegram.",
  telegram_read_messages: "Reading your Telegram messages.",
  telegram_find_contact: "Working out who you mean.",
  telegram_send: "Sending the Telegram message.",
  telegram_send_file: "Sending the file on Telegram.",
  plaid_list_accounts: "Checking your bank balances.",
  plaid_transactions: "Looking through your transactions.",
  [RUN_CODE]: "Working through that now.",
  [MEMORY_TOOL.function.name]: "Checking what I remember.",
};

/** Built in rather than exposed as a connector: the harness owns this capability. */
const WEB_SEARCH_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live internet for facts about the world outside the caller's accounts: news, " +
      "current events, prices, releases, documentation. Returns the top results with their text. " +
      "Do not use it for the caller's private data.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        numResults: {
          type: "integer",
          description: "How many results to return. Defaults to 5, maximum 8.",
        },
      },
      required: ["query"],
    },
  },
};

export interface HarnessResult {
  text: string;
  steps: string[];
}

export class ConnectorHarness {
  private mcpSchemas: ToolSchema[] | null = null;
  /** Null when the caller's Telegram object could not be reached at all. */
  private readonly telegram: TelegramToolbox | null;
  private readonly code: CodeToolbox | null;
  private readonly plaid: PlaidToolbox;
  /** Null when this user has no memory object (no Atlas configured). */
  private readonly memory: MemoryToolbox | null;
  /**
   * What each earlier run on this harness did, one block per request.
   *
   * Every request re-reads the conversation, but the conversation holds only
   * what was said aloud: without this, a later "send it" or "have you sent it?"
   * cannot see the document it made or the message it sent, and does it again.
   */
  private readonly worklog: string[] = [];

  constructor(
    private readonly mcp: McpClient,
    private readonly deepseekKey: string,
    private readonly exaKey: string,
    private readonly userId: string,
    telegram: TelegramActions | null = null,
    executor: Executor | null = null,
    plaid: PlaidActions | null = null,
    memory: MemoryActions | null = null,
  ) {
    this.telegram = telegram ? new TelegramToolbox(telegram) : null;
    this.plaid = new PlaidToolbox(plaid);
    this.memory = memory ? new MemoryToolbox(memory) : null;
    this.code = executor
      ? new CodeToolbox({
          executor,
          mcp,
          telegram,
          webSearch: (query, numResults) => webSearch(exaKey, query, numResults),
        })
      : null;
  }

  /** Opens the MCP session and caches the tool list for later delegations. */
  async warmUp(): Promise<void> {
    if (this.mcpSchemas) return;
    await this.mcp.initialize();
    this.mcpSchemas = toSchemas(await this.mcp.listTools());
  }

  async run(
    transcript: string,
    onProgress: (note: string) => void,
    _signal?: AbortSignal,
    options?: { system?: string; maxAnswerChars?: number },
  ): Promise<HarnessResult> {
    await this.warmUp();
    const schemas = [
      ...(this.mcpSchemas ?? []),
      ...(this.telegram ? TELEGRAM_TOOLS : []),
      ...plaidTools(),
      WEB_SEARCH_TOOL,
      ...(this.code ? [RUN_CODE_TOOL] : []),
      ...(this.memory ? [MEMORY_TOOL] : []),
    ];

    // Jev walks the memory tree for the latest request before the model
    // starts, so a name, a preference or a saved procedure is already in
    // front of it rather than a lookup it has to think to make.
    const remembered = this.memory ? await this.memory.recall(latestRequest(transcript), transcript) : "";
    if (remembered) onProgress("Checking what I remember.");

    const messages: ChatMessage[] = [
      { role: "system", content: options?.system ?? SYSTEM_PROMPT },
      { role: "user", content: requestContent(transcript, this.worklog, remembered) },
    ];
    const maxAnswer = options?.maxAnswerChars ?? MAX_ANSWER_CHARS;

    const steps: string[] = [];
    const done: string[] = [];
    let answer: string | null = null;

    try {
      answer = await this.loop(messages, schemas, steps, done, onProgress);
    } finally {
      // Recorded even when the run throws: a half-done job is exactly what the
      // next request must not start over.
      this.remember(done, answer);
    }

    return {
      text: truncate(answer ?? "I could not find that. Please try asking again.", maxAnswer),
      steps,
    };
  }

  private async loop(
    messages: ChatMessage[],
    schemas: ToolSchema[],
    steps: string[],
    done: string[],
    onProgress: (note: string) => void,
  ): Promise<string | null> {
    let answer: string | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await chatWithTools(this.deepseekKey, messages, schemas, this.userId);

      if (!reply.toolCalls.length) {
        answer = reply.content?.trim() ?? null;
        break;
      }

      messages.push({
        role: "assistant",
        content: reply.content ?? "",
        tool_calls: reply.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of reply.toolCalls) {
        const note = PROGRESS_NOTES[call.name] ?? "Checking that for you.";
        steps.push(call.name);
        onProgress(note);

        let output: string;
        try {
          if (call.name === WEB_SEARCH_TOOL.function.name) {
            output = await this.search(call.arguments);
          } else if (call.name === RUN_CODE && this.code) {
            output = await this.code.run(call.arguments);
          } else if (this.telegram?.handles(call.name)) {
            output = await this.telegram.run(call.name, call.arguments);
          } else if (this.plaid.handles(call.name)) {
            output = await this.plaid.run(call.name, call.arguments);
          } else if (this.memory?.handles(call.name)) {
            output = await this.memory.run(call.arguments);
          } else {
            output = await this.mcpCall(call.name, call.arguments);
          }
        } catch (error) {
          output = `The tool call failed: ${errorMessage(error)}`;
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: truncate(output, MAX_TOOL_CHARS) });
        if (!UNLOGGED_TOOLS.has(call.name)) {
          done.push(
            `${call.name} ${truncate(call.arguments, WORKLOG_ARGS_CHARS)} -> ${truncate(output, WORKLOG_OUTPUT_CHARS)}`,
          );
        }
      }
    }

    // Out of steps with the work possibly done: the tool results above are the
    // record of it, and the caller must hear that rather than the fallback.
    if (answer === null && steps.length) {
      messages.push({
        role: "user",
        content:
          "No more tool calls are possible. Answer now from the tool results above: say what was " +
          "done and confirmed, and what was not.",
      });
      const reply = await chatWithTools(this.deepseekKey, messages, schemas, this.userId, "none");
      answer = reply.content?.trim() || null;
    }

    return answer;
  }

  /** The most recent run's record — what the memory pass reads to keep a workflow. */
  lastWork(): string | null {
    return this.worklog.length ? this.worklog[this.worklog.length - 1] : null;
  }

  /** Every run so far on this harness, oldest first: the call's whole work record. */
  allWork(): string | null {
    return this.worklog.length ? this.worklog.join("\n") : null;
  }

  /** Adds one run to the worklog, keeping the newest requests within the cap. */
  private remember(done: string[], answer: string | null): void {
    if (!done.length && !answer) return;

    const lines = [
      `Request at ${new Date().toISOString()}:`,
      ...(done.length ? done.map((line) => `  ${line}`) : ["  (no tools used)"]),
      `  Answer given: ${answer ?? "(none — the run stopped before answering)"}`,
    ];
    this.worklog.push(lines.join("\n"));

    let total = this.worklog.reduce((sum, block) => sum + block.length, 0);
    while (this.worklog.length > 1 && total > MAX_WORKLOG_CHARS) {
      total -= this.worklog.shift()!.length;
    }
  }

  private async mcpCall(name: string, rawArguments: string): Promise<string> {
    const result = await this.mcp.callTool(name, parseArguments(rawArguments));
    return result.text || "(the tool returned nothing)";
  }

  /** Flattens Exa results into text the model can answer from without another call. */
  private async search(rawArguments: string): Promise<string> {
    const args = parseArguments(rawArguments) as { query?: string; numResults?: number };
    const query = (args.query ?? "").trim();
    if (!query) return "web_search needs a query.";

    const results = await webSearch(this.exaKey, query, args.numResults ?? 5);
    if (!results.length) return `The web search for "${query}" returned nothing.`;

    return results.map((result) => `${result.title}\n${result.url}\n${result.text}`).join("\n\n");
  }
}

/**
 * The run's opening message: what memory holds, the earlier work, when there
 * is any, then the conversation.
 */
function requestContent(transcript: string, worklog: readonly string[], remembered = ""): string {
  const conversation = `Conversation so far (act on the caller's latest request):\n${transcript}`;
  const parts: string[] = [];
  if (remembered) parts.push(remembered);
  if (worklog.length) {
    parts.push(
      "Already done earlier in this call. These are real tool results, so do not redo any of it:\n" +
        worklog.join("\n"),
    );
  }
  parts.push(conversation);
  return parts.join("\n\n");
}

/** The caller's most recent line: what the memory read is about. */
export function latestRequest(transcript: string): string {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (/^(caller|user):/i.test(line)) return line.replace(/^(caller|user):\s*/i, "").trim();
  }
  return lines[lines.length - 1]?.replace(/^\w+:\s*/, "").trim() ?? "";
}

/** MCP tools describe arguments with JSON Schema, which is what the model wants. */
function toSchemas(tools: McpTool[]): ToolSchema[] {
  return tools.map((tool) => {
    const schema = tool.inputSchema ?? {};
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: { type: "object", properties: {}, ...schema },
      },
    };
  });
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}… (truncated)` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
