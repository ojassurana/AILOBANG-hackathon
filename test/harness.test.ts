/**
 * Tests for the harness loop's ending.
 *
 * A long job can use every step on tool calls and never get to say what it
 * did. The work is real by then, so the caller must hear it rather than the
 * "could not find that" fallback. DeepSeek is stubbed at fetch, which is the
 * only way the loop reaches it.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { ConnectorHarness } from "../src/harness";
import type { McpClient } from "../src/mcp";

let passed = 0;
let failed = 0;

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

const mcp = {
  async initialize() {},
  async listTools() {
    return [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "run tools", inputSchema: {} }];
  },
  async callTool() {
    return { text: '{"data":{"results":[{"response":{"successful":true,"data":{"id":"doc1"}}}]}}', isError: false };
  },
} as unknown as McpClient;

function stubDeepSeek(answer: (body: any) => { content: string | null; tool_calls?: unknown[] }) {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return new Response(JSON.stringify({ choices: [{ message: answer(body) }] }), { status: 200 });
  }) as typeof fetch;
  return bodies;
}

const realFetch = globalThis.fetch;

await check("a loop that runs out of steps still answers from what it did", async () => {
  const bodies = stubDeepSeek((body) =>
    body.tool_choice === "none"
      ? { content: "Created the doc; the share step did not run." }
      : {
          content: null,
          tool_calls: [{ id: `c${body.messages.length}`, function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: "{}" } }],
        },
  );
  const harness = new ConnectorHarness(mcp, "key", "exa", "user");
  const result = await harness.run("user: make a doc and share it", () => {});

  assert.equal(result.text, "Created the doc; the share step did not run.");
  assert.equal(result.steps.length, 10);
  const last = bodies.at(-1);
  assert.equal(last.tool_choice, "none");
  assert.match(last.messages.at(-1).content, /No more tool calls/);
});

await check("a loop that answers in time makes no extra call", async () => {
  const bodies = stubDeepSeek(() => ({ content: "Nothing to do." }));
  const harness = new ConnectorHarness(mcp, "key", "exa", "user");
  const result = await harness.run("user: hi", () => {});

  assert.equal(result.text, "Nothing to do.");
  assert.equal(bodies.length, 1);
});

await check("a later request sees what an earlier one did, not just what was said", async () => {
  // The voice transcript only holds speech. "Have you sent it?" was answered
  // with "I still need to create the doc" because the doc's tool result was gone.
  let firstRun = true;
  const bodies = stubDeepSeek((body) => {
    const last = body.messages.at(-1);
    if (firstRun && last.role === "user") {
      return {
        content: null,
        tool_calls: [
          {
            id: "c1",
            function: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: '{"tools":[{"tool_slug":"GOOGLEDOCS_CREATE_DOCUMENT"}]}' },
          },
        ],
      };
    }
    firstRun = false;
    return { content: last.role === "tool" ? "Made the doc." : "Yes, the doc is made." };
  });
  const harness = new ConnectorHarness(mcp, "key", "exa", "user");

  await harness.run("Caller: make a doc for Himanshu", () => {});
  const firstRequest = bodies[0].messages[1].content;
  assert.doesNotMatch(firstRequest, /Already done earlier/);

  const later = await harness.run("Caller: make a doc for Himanshu\nCaller: is it made?", () => {});
  const secondRequest = bodies.at(-1).messages[1].content;
  assert.match(secondRequest, /Already done earlier in this call/);
  assert.match(secondRequest, /GOOGLEDOCS_CREATE_DOCUMENT/);
  assert.match(secondRequest, /"id":"doc1"/);
  assert.match(secondRequest, /Answer given: Made the doc\./);
  assert.ok(secondRequest.indexOf("Already done") < secondRequest.indexOf("Conversation so far"));
  assert.equal(later.text, "Yes, the doc is made.");
});

await check("the record of earlier work stays bounded, dropping the oldest first", async () => {
  const bodies = stubDeepSeek(() => ({ content: `answer ${"x".repeat(3000)}` }));
  const harness = new ConnectorHarness(mcp, "key", "exa", "user");
  for (let index = 0; index < 5; index++) await harness.run(`Caller: request ${index}`, () => {});
  const request = bodies.at(-1).messages[1].content as string;
  assert.ok(request.length < 12000, `the request grew to ${request.length} characters`);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
