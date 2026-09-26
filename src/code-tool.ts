/**
 * `run_code`: the harness tool that lets the model write one JavaScript program
 * instead of stepping through tool calls one model turn at a time.
 *
 * The program runs in a Dynamic Worker (Cloudflare's Worker Loader) that has no
 * network access and no secrets. Everything it can do goes through the
 * functions below, and each of those runs back here, in the agent's Durable
 * Object, with the real keys: the Composio session, the caller's Telegram
 * object and Exa. So a program can chain and loop over the caller's accounts,
 * but cannot reach anything the ordinary tools could not. The one fetch it can
 * ask for is a file Composio has already downloaded to its own storage.
 *
 * Telegram's confirm step is deliberately missing. A program can prepare a
 * message; only the model, after the caller has heard it and said yes, sends it.
 */

import type { Executor, ResolvedProvider } from "@cloudflare/codemode";
import type { ToolSchema } from "./deepseek";
import type { WebResult } from "./exa";
import type { McpClient } from "./mcp";
import type { TelegramActions } from "./telegram-tools";

export const RUN_CODE = "run_code";

/**
 * Host calls one program may make. High enough for a real bulk job across a
 * folder or an inbox, low enough that a runaway loop stops long before it
 * matters to the caller's accounts or the Composio bill.
 */
export const MAX_CODE_CALLS = 60;
/** Wall clock for one program, tool calls included. */
export const CODE_TIMEOUT_MS = 60000;
/** Composio runs at most this many tools in one multi-execute. */
const MULTI_EXECUTE_LIMIT = 50;
/** More than a program needs to read a document; less than would stall the object. */
const MAX_FILE_CHARS = 200_000;
/**
 * Where Composio puts a downloaded file: a presigned link on its own R2
 * storage. composio.readFile fetches only these, so a program told to by what it
 * read still has nowhere to send the caller's data.
 */
const COMPOSIO_FILE_HOST = /^temp\.[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/;

/** The prompt section every harness prompt carries when run_code is offered. */
export const CODE_GUIDANCE = `## Chained and bulk work
When a request takes several dependent steps (one step's output feeds the next,
like a new document's link going into a message) or the same action over many
items, find the slugs as above and get their schemas with COMPOSIO_GET_TOOL_SCHEMAS
and include ["input_schema", "output_schema"], so the program knows the shape of
each tool's data. Then do the work in one run_code program instead of one tool
call per step. Use run_code rather than COMPOSIO_REMOTE_WORKBENCH or
COMPOSIO_REMOTE_BASH_TOOL. A single lookup or a single action does not need it.
Only act on the items the caller asked about: if
the program cannot find exactly those, return that rather than falling back to
something similar elsewhere in their account.`;

export const RUN_CODE_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: RUN_CODE,
    description:
      "Run one JavaScript program that calls the caller's tools, for work that chains or loops: " +
      "an output of one step feeding the next (create a doc, then use its link), the same action " +
      "over many items, or filtering a big result down to what matters. Prefer the ordinary tools " +
      "for a single lookup or action.\n" +
      "Find tool slugs and their argument schemas with COMPOSIO_SEARCH_TOOLS and " +
      "COMPOSIO_GET_TOOL_SCHEMAS first, as ordinary tool calls, then write the program.\n" +
      "The code is the body of an async function: use await, and `return` a small JSON value " +
      "with only what the answer needs. console.log output comes back too. There is no fetch " +
      "and no network; these globals are the only way out:\n" +
      "  composio.run(slug, args) -> the tool's `data` object; throws with the tool's error.\n" +
      "  composio.runAll([{ slug, args }]) -> [{ ok, data, error }] in order, all at once.\n" +
      "  composio.search(useCase) -> [{ useCase, slugs }] for a plain-English use case.\n" +
      "  composio.schemas([slug]) -> { [slug]: inputSchema }.\n" +
      "  composio.readFile(url) -> the text of a file a Composio tool returned as a download " +
      "link (e.g. downloaded_file_content.s3url). Download and read in the same program: the " +
      "links are signed, so one copied out of an earlier result will not work.\n" +
      "  web.search(query, numResults?) -> [{ title, url, text }].\n" +
      "  telegram.listChats(limit?), telegram.readMessages(chat, limit?), " +
      "telegram.findContacts(name) -> arrays; telegram.prepareSend(to, text) prepares one " +
      "message and does NOT send it.\n" +
      "Each Composio call takes seconds, so never await calls one by one in a loop when they do " +
      "not depend on each other: put them in one composio.runAll. Await in sequence only when a " +
      "call needs an earlier call's result.\n" +
      `At most ${MAX_CODE_CALLS} calls per program. If you do not know the shape of a tool's ` +
      "data, return it from a first small program rather than guessing field names.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The program: the body of an async function that returns the result.",
        },
      },
      required: ["code"],
    },
  },
};

export interface CodeDeps {
  executor: Executor;
  mcp: McpClient;
  webSearch: (query: string, numResults: number) => Promise<WebResult[]>;
  telegram: TelegramActions | null;
  fetch?: typeof fetch;
}

interface ComposioOutcome {
  ok: boolean;
  data: unknown;
  error: string | null;
}

export class CodeToolbox {
  constructor(private readonly deps: CodeDeps) {}

  /** Runs one program and returns what it produced, as text for the model. */
  async run(rawArguments: string): Promise<string> {
    const code = codeArgument(rawArguments);
    if (!code) {
      return `${RUN_CODE} needs a "code" string. If it was long, the arguments may have been cut off; write a shorter program.`;
    }

    let calls = 0;
    const budget = () => {
      calls++;
      if (calls > MAX_CODE_CALLS) {
        throw new Error(`This program made more than ${MAX_CODE_CALLS} tool calls; do the work in smaller batches.`);
      }
    };
    // What the program did to the caller's accounts. A program that throws
    // loses its return value, and without this the model cannot tell a
    // half-done job (a sheet created, the write into it failed) from one that
    // never started, so it redoes the parts that already happened.
    const trace: string[] = [];

    const outcome = await this.deps.executor.execute(code, this.providers(budget, trace));
    return JSON.stringify({
      ...(outcome.error ? { error: outcome.error } : { result: outcome.result ?? null }),
      ...(outcome.logs?.length ? { logs: outcome.logs } : {}),
      calls,
      ...(trace.length ? { trace } : {}),
    });
  }

  private providers(budget: () => void, trace: string[]): ResolvedProvider[] {
    const providers: ResolvedProvider[] = [
      {
        name: "composio",
        fns: {
          run: async (slug: unknown, args: unknown) => {
            budget();
            const [outcome] = await this.execute([{ slug, args }], trace);
            if (!outcome.ok) throw new Error(outcome.error ?? `${String(slug)} failed`);
            return outcome.data;
          },
          runAll: async (items: unknown) => {
            const list = Array.isArray(items) ? (items as { slug?: unknown; args?: unknown }[]) : [];
            list.forEach(() => budget());
            const outcomes: ComposioOutcome[] = [];
            for (let start = 0; start < list.length; start += MULTI_EXECUTE_LIMIT) {
              outcomes.push(...(await this.execute(list.slice(start, start + MULTI_EXECUTE_LIMIT), trace)));
            }
            return outcomes;
          },
          search: async (useCase: unknown) => {
            budget();
            return this.search(useCase);
          },
          schemas: async (slugs: unknown) => {
            budget();
            return this.schemas(slugs);
          },
          readFile: async (url: unknown) => {
            budget();
            return this.readFile(url);
          },
        },
      },
      {
        name: "web",
        fns: {
          search: async (query: unknown, numResults: unknown) => {
            budget();
            const text = typeof query === "string" ? query.trim() : "";
            if (!text) throw new Error("web.search needs a query.");
            return this.deps.webSearch(text, typeof numResults === "number" ? numResults : 5);
          },
        },
      },
    ];

    const telegram = this.deps.telegram;
    if (telegram) {
      const connected = async () => {
        budget();
        const status = await telegram.status();
        // Without a session the object answers with an empty inbox, which a
        // program would read as "nobody has messaged you".
        if (status.phase !== "connected" || !status.hasSession) {
          throw new Error("Telegram isn't connected on this account.");
        }
      };
      providers.push({
        name: "telegram",
        fns: {
          listChats: async (limit: unknown) => {
            await connected();
            return telegram.listChats(count(limit));
          },
          readMessages: async (chat: unknown, limit: unknown) => {
            await connected();
            return telegram.readMessages(String(chat ?? ""), count(limit));
          },
          findContacts: async (name: unknown) => {
            await connected();
            return telegram.findContacts(String(name ?? ""));
          },
          prepareSend: async (to: unknown, text: unknown) => {
            await connected();
            return telegram.prepareSend(String(to ?? ""), String(text ?? ""));
          },
        },
      });
    }

    return providers;
  }

  private async readFile(url: unknown): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(String(url ?? ""));
    } catch {
      throw new Error("composio.readFile needs the download link a Composio tool returned.");
    }
    if (parsed.protocol !== "https:" || !COMPOSIO_FILE_HOST.test(parsed.hostname)) {
      throw new Error("composio.readFile only reads download links returned by Composio tools.");
    }

    const response = await (this.deps.fetch ?? fetch)(parsed.toString());
    if (!response.ok) throw new Error(`The download link answered ${response.status}; it may have expired.`);
    const text = await response.text();
    return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}… (truncated)` : text;
  }

  /** One Composio multi-execute, unwrapped to one outcome per requested tool. */
  private async execute(items: { slug?: unknown; args?: unknown }[], trace: string[]): Promise<ComposioOutcome[]> {
    if (!items.length) return [];
    const result = await this.deps.mcp.callTool("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: items.map((item) => ({ tool_slug: String(item.slug ?? ""), arguments: item.args ?? {} })),
      sync_response_to_workbench: false,
    });
    const outcomes = unwrapMultiExecute(result.text, items.length);
    outcomes.forEach((outcome, index) => trace.push(traceLine(String(items[index].slug ?? ""), outcome)));
    return outcomes;
  }

  private async search(useCase: unknown): Promise<{ useCase: string; slugs: string[] }[]> {
    const cases = (Array.isArray(useCase) ? useCase : [useCase]).map(String).filter(Boolean);
    if (!cases.length) throw new Error("composio.search needs a use case.");
    const result = await this.deps.mcp.callTool("COMPOSIO_SEARCH_TOOLS", {
      queries: cases.map((text) => ({ use_case: text })),
      session: { generate_id: true },
    });
    const parsed = parse(result.text) as {
      data?: { results?: { use_case?: string; primary_tool_slugs?: string[]; related_tool_slugs?: string[] }[] };
    } | null;
    if (!parsed?.data?.results) throw new Error(result.text.slice(0, 500) || "COMPOSIO_SEARCH_TOOLS returned nothing.");
    return parsed.data.results.map((entry) => ({
      useCase: entry.use_case ?? "",
      slugs: [...(entry.primary_tool_slugs ?? []), ...(entry.related_tool_slugs ?? [])],
    }));
  }

  private async schemas(slugs: unknown): Promise<Record<string, unknown>> {
    const list = (Array.isArray(slugs) ? slugs : [slugs]).map(String).filter(Boolean);
    if (!list.length) throw new Error("composio.schemas needs at least one slug.");
    const result = await this.deps.mcp.callTool("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: list });
    const parsed = parse(result.text) as {
      data?: { tool_schemas?: Record<string, { input_schema?: unknown }> };
    } | null;
    const schemas = parsed?.data?.tool_schemas;
    if (!schemas) throw new Error(result.text.slice(0, 500) || "COMPOSIO_GET_TOOL_SCHEMAS returned nothing.");
    return Object.fromEntries(Object.entries(schemas).map(([slug, entry]) => [slug, entry?.input_schema ?? entry]));
  }
}

/**
 * Composio answers a multi-execute with one entry per tool under
 * `data.results`, each carrying `response.successful`, `response.data` and, on
 * failure, `response.error`. Anything else is reported as a failure of every
 * requested tool rather than as success with no data.
 */
export function unwrapMultiExecute(text: string, expected: number): ComposioOutcome[] {
  const parsed = parse(text) as {
    data?: { results?: { index?: number; response?: { successful?: boolean; data?: unknown; error?: unknown } }[] };
    error?: unknown;
  } | null;
  const results = parsed?.data?.results;
  if (!Array.isArray(results)) {
    const error = describeError(parsed?.error) ?? (text.slice(0, 500) || "Composio returned nothing.");
    return Array.from({ length: expected }, () => ({ ok: false, data: null, error }));
  }

  const ordered: ComposioOutcome[] = Array.from({ length: expected }, () => ({
    ok: false,
    data: null,
    error: "Composio returned no result for this tool.",
  }));
  results.forEach((entry, position) => {
    const index = typeof entry.index === "number" ? entry.index : position;
    if (index < 0 || index >= expected) return;
    const response = entry.response ?? {};
    ordered[index] = response.successful
      ? { ok: true, data: response.data ?? null, error: null }
      : { ok: false, data: response.data ?? null, error: describeError(response.error) ?? "The tool failed." };
  });
  return ordered;
}

/** One call, with enough of what it touched (the id and name it returned) to find it again. */
function traceLine(slug: string, outcome: ComposioOutcome): string {
  if (!outcome.ok) return `${slug} failed: ${(outcome.error ?? "").slice(0, 160)}`;
  const data = outcome.data as { id?: unknown; name?: unknown } | null;
  const id = typeof data?.id === "string" ? ` id=${data.id}` : "";
  const name = typeof data?.name === "string" ? ` name="${data.name}"` : "";
  return `${slug} ok${id}${name}`;
}

function codeArgument(raw: string): string {
  const parsed = parse(raw || "{}") as { code?: unknown } | null;
  return typeof parsed?.code === "string" ? parsed.code.trim() : "";
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeError(error: unknown): string | null {
  if (error === null || error === undefined || error === "") return null;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
