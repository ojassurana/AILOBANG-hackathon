/**
 * Tests for the humanize loop's stop condition.
 *
 * The loop is only as trustworthy as its reading of the detector. The property
 * that matters most: an unreadable, sandboxed or failed detector response must
 * never come back as a score of 0, because 0 is what ends the loop and tells the
 * caller the work is verified. A fabricated zero would mark unchecked text as
 * clean, silently, every time.
 *
 * Run: see test/run.sh
 */

import assert from "node:assert/strict";
import { detectAi, extractPercent, isScoreable, looksLikeMock } from "../src/detector";
import { strategyFor } from "../src/humanize";

const long = "a".repeat(300);

let passed = 0;
let failed = 0;

async function check(name: string, run: () => void | Promise<void>) {
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

/** A detector that answers with whatever body the test wants. */
function callerReturning(body: string) {
  return async () => body;
}

/** Records which tool slugs were asked for, to prove the fallback order. */
function callerSequence(map: Record<string, string>) {
  const asked: string[] = [];
  const call = async (name: string) => {
    asked.push(name);
    const body = map[name];
    if (body === undefined) throw new Error(`${name}: not connected`);
    return body;
  };
  return { call, asked };
}

console.log("\ndetector: reading a score honestly");

await check("a real copyleaks body yields its percentage", async () => {
  const result = await detectAi(callerReturning(JSON.stringify({ summary: { ai: 0.87 } })), long);
  assert.equal(result.aiScore, 87);
  assert.equal(result.source, "copyleaks");
});

await check("a 0-100 body is not doubled into 8700", async () => {
  const result = await detectAi(callerReturning(JSON.stringify({ summary: { ai: 87 } })), long);
  assert.equal(result.aiScore, 87);
});

await check("a genuine 0 is returned as 0, not rejected", async () => {
  const result = await detectAi(callerReturning(JSON.stringify({ summary: { ai: 0 } })), long);
  assert.equal(result.aiScore, 0);
});

await check("a sandbox mock body never becomes a score", async () => {
  const mock = JSON.stringify({ sandbox: true, summary: { ai: 0 } });
  const result = await detectAi(callerReturning(mock), long);
  assert.equal(result.aiScore, null, "a mock must not be scored, even when it reads 0");
});

await check("unparseable output never becomes a score", async () => {
  const result = await detectAi(callerReturning("<html>503</html>"), long);
  assert.equal(result.aiScore, null);
});

await check("a percentage outside 0-100 is rejected", async () => {
  const result = await detectAi(callerReturning(JSON.stringify({ summary: { ai: 42000 } })), long);
  assert.equal(result.aiScore, null);
});

await check("text under 255 characters is not scored at all", async () => {
  const result = await detectAi(callerReturning(JSON.stringify({ summary: { ai: 0 } })), "too short");
  assert.equal(result.aiScore, null);
  assert.match(String(result.unavailable), /too short/i);
});

await check("a broken copyleaks falls through to winston", async () => {
  const { call, asked } = callerSequence({
    COPYLEAKS_DETECT_AI_TEXT: JSON.stringify({ sandbox: true, summary: { ai: 0 } }),
    WINSTON_AI_AI_TEXT_DETECTION: JSON.stringify({ score: 12 }),
  });
  const result = await detectAi(call, long);
  assert.equal(result.source, "winston");
  assert.equal(result.aiScore, 12);
  assert.deepEqual(asked, ["COPYLEAKS_DETECT_AI_TEXT", "WINSTON_AI_AI_TEXT_DETECTION"]);
});

await check("both detectors failing yields null, not 0", async () => {
  const result = await detectAi(callerSequence({}).call, long);
  assert.equal(result.aiScore, null);
  assert.equal(result.source, "none");
});

await check("every call asks for a fresh scan id", async () => {
  const seen: string[] = [];
  const call = async (_name: string, args: Record<string, unknown>) => {
    seen.push(String(args.scan_id));
    return JSON.stringify({ summary: { ai: 5 } });
  };
  await detectAi(call, long);
  await detectAi(call, long);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "a reused scan id is rejected by copyleaks as a duplicate");
});

await check("sandbox is never left at its default", async () => {
  const args: Record<string, unknown>[] = [];
  const call = async (_name: string, a: Record<string, unknown>) => {
    args.push(a);
    return JSON.stringify({ summary: { ai: 5 } });
  };
  await detectAi(call, long);
  assert.equal(args[0].sandbox, false, "the default is true, which returns mock output");
});

console.log("\nparsing");

await check("extractPercent finds a nested key", () => {
  assert.equal(extractPercent(JSON.stringify({ data: { result: { aiScore: 0.42 } } }), ["aiScore"]), 42);
});

await check("extractPercent ignores non-numeric values", () => {
  assert.equal(extractPercent(JSON.stringify({ ai: "high" }), ["ai"]), null);
});

await check("looksLikeMock spots the sandbox body", () => {
  assert.equal(looksLikeMock("this is fixed Copyleaks mock output for integration testing"), true);
  assert.equal(looksLikeMock(JSON.stringify({ summary: { ai: 12 } })), false);
});

console.log("\nescalation ladder");

await check("pass 1 is light, 2 is aggressive, 3+ is structural", () => {
  assert.equal(strategyFor(1).strategy, "light");
  assert.equal(strategyFor(2).strategy, "aggressive");
  assert.equal(strategyFor(3).strategy, "structural");
  assert.equal(strategyFor(9).strategy, "structural");
});

await check("isScoreable matches the 255 character floor", () => {
  assert.equal(isScoreable("a".repeat(254)), false);
  assert.equal(isScoreable("a".repeat(255)), true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
