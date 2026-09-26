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

import { chatWithTools, type ChatMessage, type ToolSchema } from "./deepseek";
import { webSearch } from "./exa";
import type { McpClient, McpTool } from "./mcp";

/** Enough for search → schema → execute plus a summary; a cap keeps calls snappy. */
const MAX_STEPS = 6;
/** Tool output beyond this is noise for a spoken answer and slows the loop down. */
const MAX_TOOL_CHARS = 6000;
const MAX_ANSWER_CHARS = 1500;

const SYSTEM_PROMPT = `## Voice conversation context
You are the backend for an assistant in a live voice call. You do not speak:
you return one short, factual result that the voice assistant reads aloud.
Transcripts can contain mistakes, unfinished phrases and corrections. Use the
latest context and verified tool results. If a needed detail is missing, say
which detail you still need instead of guessing.

## Connected accounts
The tools below act on the caller's own connected accounts: Google (Gmail, Drive,
Calendar, Sheets, Docs, Photos, Contacts, Tasks), Reddit, LinkedIn, Slack, Notion,
Discord, Google Maps and Cursor.

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

  constructor(
    private readonly mcp: McpClient,
    private readonly deepseekKey: string,
    private readonly exaKey: string,
    private readonly userId: string,
  ) {}

  /** Opens the MCP session and caches the tool list for later delegations. */
  async warmUp(): Promise<void> {
    if (this.mcpSchemas) return;
    await this.mcp.initialize();
    this.mcpSchemas = toSchemas(await this.mcp.listTools());
  }

  async run(transcript: string, onProgress: (note: string) => void): Promise<HarnessResult> {
    await this.warmUp();
    const schemas = [...(this.mcpSchemas ?? []), WEB_SEARCH_TOOL];

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Conversation so far:\n${transcript}` },
    ];

    const steps: string[] = [];
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
          output =
            call.name === WEB_SEARCH_TOOL.function.name
              ? await this.search(call.arguments)
              : await this.mcpCall(call.name, call.arguments);
        } catch (error) {
          output = `The tool call failed: ${errorMessage(error)}`;
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: truncate(output, MAX_TOOL_CHARS) });
      }
    }

    return {
      text: truncate(answer ?? "I could not find that. Please try asking again.", MAX_ANSWER_CHARS),
      steps,
    };
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
