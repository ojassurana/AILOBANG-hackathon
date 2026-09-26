/**
 * Tests for run_code, the harness tool that runs a model-written program.
 *
 * The real program runs in a Dynamic Worker, which node cannot host, so these
 * use an executor that evaluates the code in-process with the same provider
 * namespaces in scope. What is under test is everything around the sandbox:
 * the functions a program is given, how Composio's answers are unwrapped for
 * it, and the limits that stop a program doing more than it was asked.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import type { Executor, ResolvedProvider } from "@cloudflare/codemode";
import { CodeToolbox, MAX_CODE_CALLS, RUN_CODE, RUN_CODE_TOOL, unwrapMultiExecute } from "../src/code-tool";
import type { McpClient } from "../src/mcp";
import type { TelegramActions } from "../src/telegram-tools";
import type { TelegramStatus } from "../src/telegram";

let passed = 0;
let failed = 0;
const checks: Promise<void>[] = [];

function check(name: string, run: () => Promise<void> | void) {
  checks.push(
    Promise.resolve()
      .then(run)
      .then(() => {
        passed++;
        console.log(`  ok   ${name}`);
      })
      .catch((error) => {
        failed++;
        console.log(`  FAIL ${name}`);
        console.log(`       ${error instanceof Error ? error.message : String(error)}`);
      }),
  );
}

/** Evaluates the program in-process, with each provider's functions as a global. */
const inProcess: Executor = {
  async execute(code, providersOrFns) {
    const providers = providersOrFns as ResolvedProvider[];
    const names = providers.map((provider) => provider.name);
    const scopes = providers.map((provider) => provider.fns);
    try {
      const program = new Function(...names, `return (async () => {\n${code}\n})();`);
      return { result: await program(...scopes) };
    } catch (error) {
      return { result: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

function multiExecuteReply(results: { successful: boolean; data?: unknown; error?: string }[]): string {
  return JSON.stringify({
    data: {
      results: results.map((response, index) => ({ response, tool_slug: `TOOL_${index}`, index })),
    },
    error: null,
    successful: results.every((result) => result.successful),
  });
}

interface McpCall {
  name: string;
  args: any;
}

function fakeMcp(reply: (call: McpCall) => string) {
  const calls: McpCall[] = [];
  const mcp = {
    async callTool(name: string, args: unknown) {
      const call = { name, args };
      calls.push(call);
      return { text: reply(call), isError: false };
    },
  } as unknown as McpClient;
  return { mcp, calls };
}

/** Every requested tool succeeds and echoes back what it was given. */
const echo = (call: McpCall) =>
  multiExecuteReply(
    (call.args.tools as { tool_slug: string; arguments: unknown }[]).map((tool) => ({
      successful: true,
      data: { slug: tool.tool_slug, args: tool.arguments },
    })),
  );

function toolbox(options: { mcp?: McpClient; telegram?: TelegramActions | null } = {}) {
  return new CodeToolbox({
    executor: inProcess,
    mcp: options.mcp ?? fakeMcp(echo).mcp,
    telegram: options.telegram ?? null,
    webSearch: async (query) => [{ title: `About ${query}`, url: "https://example.com", text: "text" }],
  });
}

async function run(
  box: CodeToolbox,
  code: string,
): Promise<{ result?: any; error?: string; calls: number; trace?: string[] }> {
  return JSON.parse(await box.run(JSON.stringify({ code })));
}

/* ------------------------------------------------------ composio unwrapping */

check("a successful multi-execute is unwrapped to each tool's data", () => {
  const outcomes = unwrapMultiExecute(
    multiExecuteReply([{ successful: true, data: { id: "doc1" } }, { successful: true, data: { id: "doc2" } }]),
    2,
  );
  assert.deepEqual(outcomes, [
    { ok: true, data: { id: "doc1" }, error: null },
    { ok: true, data: { id: "doc2" }, error: null },
  ]);
});

check("a failed tool carries its own error, and its neighbour still succeeds", () => {
  const outcomes = unwrapMultiExecute(
    multiExecuteReply([
      { successful: true, data: { id: "ok" } },
      { successful: false, data: { status_code: 400 }, error: "Following fields are missing: {'name'}" },
    ]),
    2,
  );
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[1].ok, false);
  assert.match(outcomes[1].error ?? "", /missing/);
});

check("results are placed by Composio's index, not by arrival order", () => {
  const text = JSON.stringify({
    data: {
      results: [
        { index: 1, response: { successful: true, data: "second" } },
        { index: 0, response: { successful: true, data: "first" } },
      ],
    },
  });
  assert.deepEqual(unwrapMultiExecute(text, 2).map((outcome) => outcome.data), ["first", "second"]);
});

check("an answer that is not a multi-execute result fails every tool rather than passing silently", () => {
  const outcomes = unwrapMultiExecute("upstream timed out", 2);
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((outcome) => !outcome.ok && outcome.error === "upstream timed out"));
});

/* ---------------------------------------------------------------- programs */

check("composio.run hands a program the tool's data and chains into the next call", async () => {
  const { mcp, calls } = fakeMcp(echo);
  const out = await run(
    toolbox({ mcp }),
    `const doc = await composio.run("CREATE_DOC", { title: "Notes" });
     const shared = await composio.run("SHARE", { id: doc.slug + ":" + doc.args.title });
     return shared.args.id;`,
  );
  assert.equal(out.result, "CREATE_DOC:Notes");
  assert.equal(out.calls, 2);
  assert.deepEqual(
    calls.map((call) => [call.name, call.args.tools[0].tool_slug]),
    [
      ["COMPOSIO_MULTI_EXECUTE_TOOL", "CREATE_DOC"],
      ["COMPOSIO_MULTI_EXECUTE_TOOL", "SHARE"],
    ],
  );
  assert.equal(calls[0].args.sync_response_to_workbench, false);
});

check("a failing tool throws inside the program with the tool's own error", async () => {
  const { mcp } = fakeMcp(() => multiExecuteReply([{ successful: false, error: "File not found: abc" }]));
  const out = await run(toolbox({ mcp }), `return await composio.run("GET_FILE", { id: "abc" });`);
  assert.equal(out.error, "File not found: abc");
});

check("a program that fails halfway still reports what it already did", async () => {
  const { mcp } = fakeMcp((call) =>
    call.args.tools[0].tool_slug === "CREATE_SHEET"
      ? multiExecuteReply([{ successful: true, data: { id: "sheet1", name: "Folder index" } }])
      : multiExecuteReply([{ successful: false, error: "Unable to parse range: Sheet1!A1:D16" }]),
  );
  const out = (await run(
    toolbox({ mcp }),
    `const sheet = await composio.run("CREATE_SHEET", { name: "Folder index" });
     await composio.run("WRITE_VALUES", { id: sheet.id });
     return "done";`,
  )) as { error?: string; trace?: string[] };
  assert.match(out.error ?? "", /Unable to parse range/);
  assert.deepEqual(out.trace, [
    'CREATE_SHEET ok id=sheet1 name="Folder index"',
    "WRITE_VALUES failed: Unable to parse range: Sheet1!A1:D16",
  ]);
});

check("a program can catch a failing tool and carry on", async () => {
  const { mcp } = fakeMcp(() => multiExecuteReply([{ successful: false, error: "nope" }]));
  const out = await run(
    toolbox({ mcp }),
    `try { await composio.run("X", {}); } catch (e) { return "handled: " + e.message; }`,
  );
  assert.equal(out.result, "handled: nope");
});

check("composio.runAll keeps order and splits past Composio's 50-tool limit", async () => {
  const { mcp, calls } = fakeMcp(echo);
  const out = await run(
    toolbox({ mcp }),
    `const items = Array.from({ length: 55 }, (_, i) => ({ slug: "T", args: { i } }));
     const results = await composio.runAll(items);
     return results.map((r) => r.data.args.i);`,
  );
  assert.deepEqual(out.result, Array.from({ length: 55 }, (_, i) => i));
  assert.deepEqual(calls.map((call) => call.args.tools.length), [50, 5]);
});

check(`a program stops after ${MAX_CODE_CALLS} tool calls`, async () => {
  const { mcp, calls } = fakeMcp(echo);
  const out = await run(toolbox({ mcp }), `for (let i = 0; i < 1000; i++) await composio.run("T", { i });`);
  assert.match(out.error ?? "", /more than 60 tool calls/);
  assert.equal(calls.length, MAX_CODE_CALLS);
});

check("composio.search and composio.schemas return trimmed, usable data", async () => {
  const { mcp } = fakeMcp((call) =>
    call.name === "COMPOSIO_SEARCH_TOOLS"
      ? JSON.stringify({
          data: { results: [{ use_case: "create a folder", primary_tool_slugs: ["CREATE_FOLDER"], related_tool_slugs: ["FIND_FOLDER"] }] },
        })
      : JSON.stringify({
          data: { tool_schemas: { CREATE_FOLDER: { tool_slug: "CREATE_FOLDER", input_schema: { required: ["name"] } } } },
        }),
  );
  const out = await run(
    toolbox({ mcp }),
    `const found = await composio.search("create a folder");
     const schemas = await composio.schemas(found[0].slugs.slice(0, 1));
     return { found, schemas };`,
  );
  assert.deepEqual(out.result, {
    found: [{ useCase: "create a folder", slugs: ["CREATE_FOLDER", "FIND_FOLDER"] }],
    schemas: { CREATE_FOLDER: { required: ["name"] } },
  });
});

check("web.search is available to a program", async () => {
  const out = await run(toolbox(), `return (await web.search("cloudflare")).map((r) => r.title);`);
  assert.deepEqual(out.result, ["About cloudflare"]);
});

const COMPOSIO_FILE = "https://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/1/googlesuper/x?X-Amz-Signature=abc";

check("composio.readFile reads a file Composio downloaded", async () => {
  const fetched: string[] = [];
  const box = new CodeToolbox({
    executor: inProcess,
    mcp: fakeMcp(echo).mcp,
    telegram: null,
    webSearch: async () => [],
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response("This is note 3");
    }) as typeof fetch,
  });
  const out = await run(box, `return await composio.readFile(${JSON.stringify(COMPOSIO_FILE)});`);
  assert.equal(out.result, "This is note 3");
  assert.deepEqual(fetched, [COMPOSIO_FILE]);
});

check("composio.readFile refuses any link Composio did not hand out", async () => {
  const fetched: string[] = [];
  const box = new CodeToolbox({
    executor: inProcess,
    mcp: fakeMcp(echo).mcp,
    telegram: null,
    webSearch: async () => [],
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response("leaked");
    }) as typeof fetch,
  });
  for (const url of [
    "https://evil.example/?data=secret",
    "http://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com/x",
    "https://temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com.evil.example/x",
    "https://mybucket.r2.cloudflarestorage.com/x",
  ]) {
    const out = await run(box, `return await composio.readFile(${JSON.stringify(url)});`);
    assert.match(out.error ?? "", /only reads download links/, url);
  }
  assert.equal(fetched.length, 0);
});

check("a missing or cut-off code argument is reported, not run", async () => {
  const answer = await toolbox().run('{"code": "const x = ');
  assert.match(answer, /needs a "code" string/);
});

/* ---------------------------------------------------------------- telegram */

function telegram(phase: TelegramStatus["phase"]) {
  const sent: { to: string; text: string }[] = [];
  const actions: TelegramActions = {
    async status() {
      return { phase, phone: null, username: null, error: null, retryAt: null, codeViaApp: false, hasSession: phase === "connected" };
    },
    async listChats() {
      return [];
    },
    async readMessages() {
      return [];
    },
    async findContacts() {
      return [];
    },
    async send(to, text) {
      sent.push({ to, text });
      return { ok: true, reason: null, to: null, title: to, text, alreadySentAt: null };
    },
  };
  return { actions, sent };
}

check("a program can make a link and send it on Telegram in one run", async () => {
  const { actions, sent } = telegram("connected");
  const { mcp } = fakeMcp(() => multiExecuteReply([{ successful: true, data: { id: "doc1" } }]));
  const out = await run(
    toolbox({ mcp, telegram: actions }),
    `const doc = await composio.run("GOOGLEDOCS_CREATE_DOCUMENT", { title: "Notes" });
     const message = await telegram.send("Himanshu", "Here's the doc: " + doc.id);
     return { sent: message.ok };`,
  );
  assert.deepEqual(out.result, { sent: true });
  assert.deepEqual(sent, [{ to: "Himanshu", text: "Here's the doc: doc1" }]);
  assert.ok(out.trace?.includes("telegram.send to Himanshu ok"));
});

check("an unconnected Telegram is an error, not an empty inbox", async () => {
  const { actions } = telegram("idle");
  const out = await run(toolbox({ telegram: actions }), `return await telegram.listChats();`);
  assert.match(out.error ?? "", /isn't connected/);
});

/* ------------------------------------------------------------------ schema */

check("the tool is described for the model with every function a program can call", () => {
  assert.equal(RUN_CODE_TOOL.function.name, RUN_CODE);
  const description = RUN_CODE_TOOL.function.description ?? "";
  for (const fn of ["composio.run", "composio.runAll", "composio.search", "composio.schemas", "composio.readFile", "web.search", "telegram.send"]) {
    assert.ok(description.includes(fn), `the description never mentions ${fn}`);
  }
  assert.doesNotMatch(description, /prepareSend/);
});

check("the harness prompt tells the model when to reach for run_code", async () => {
  const { SYSTEM_PROMPT } = await import("../src/harness");
  assert.ok(SYSTEM_PROMPT.includes("run_code"));
  assert.match(SYSTEM_PROMPT, /one run_code/);
});

await Promise.all(checks);
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
