/**
 * Tests for the humanize loop's stop condition.
 *
 * The loop is only as trustworthy as its reading of the scorer. Two properties
 * matter most:
 *
 *   1. An unreadable, sandboxed or failed response must never come back as a
 *      score of 0, because 0 is what ends the loop and tells the caller the work
 *      is clean. A fabricated zero would mark unchecked text as clean, silently,
 *      every time.
 *   2. The local scorer's threshold must sit where the measurements put it. It
 *      was briefly set to 0.5 and that called a genuinely human essay AI.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { detectAi, detectHosted, detectLocally, extractPercent, isScoreable, looksLikeMock } from "../src/detector";
import { strategyFor } from "../src/humanize";

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

const long = "a".repeat(300);

/** Scored AI at 0.816 in the threshold measurements. */
const AI_TEXT =
  `In today's fast-paced digital landscape, artificial intelligence is not just a tool, it is a ` +
  `transformative force that is reshaping industries, redefining workflows, and reimagining what ` +
  `is possible. It is not merely about efficiency; it is about unlocking human potential. ` +
  `Organizations that embrace this pivotal technology will navigate the complexities of the modern ` +
  `realm with confidence, fostering innovation and driving sustainable growth.`;

/** Scored human at 0.106, the clearest human reading in the measurements. */
const HUMAN_TEXT =
  `ok so the bus thing. i waited 40 min at the stop near my place and then THREE of them came at ` +
  `once which is just insulting. asked the auntie next to me if this was normal and she laughed ` +
  `at me. apparently it is. anyway i was late again. got the notes from Jun though so its fine. ` +
  `dunno why i bother honestly.`;

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

console.log("\nlocal scorer: the free path");

await check("obvious AI prose is not called clean", () => {
  const result = detectLocally(AI_TEXT);
  assert.equal(result.source, "local");
  assert.equal(result.clean, false);
  assert.ok(result.aiScore !== null && result.aiScore > 70, `expected a high score, got ${result.aiScore}`);
});

await check("obvious human prose is called clean", () => {
  const result = detectLocally(HUMAN_TEXT);
  assert.equal(result.source, "local");
  assert.equal(result.clean, true);
  assert.ok(result.aiScore !== null && result.aiScore < 50, `expected a low score, got ${result.aiScore}`);
});

await check("the local scorer explains its score", () => {
  const result = detectLocally(AI_TEXT);
  assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
});

await check("the local scorer reports a percentage, not a 0-1 fraction", () => {
  const score = detectLocally(AI_TEXT).aiScore;
  assert.ok(score !== null && score > 1, "0.816 would be a fraction; 81.6 is a percentage");
});

await check("short text is not scored locally either", () => {
  const result = detectLocally("too short");
  assert.equal(result.aiScore, null);
  assert.match(String(result.unavailable), /too short/i);
});

console.log("\nchain: one scorer per run, and it is the free one");

await check("detectAi answers from the local scorer without any connection", async () => {
  const { call, asked } = callerSequence({});
  const result = await detectAi(call, AI_TEXT);
  assert.equal(result.source, "local");
  assert.deepEqual(asked, [], "the hosted detectors must not be called when the free path answered");
});

await check("text below the floor is unscoreable by the whole chain, not guessed at", async () => {
  const { call, asked } = callerSequence({ COPYLEAKS_DETECT_AI_TEXT: JSON.stringify({ summary: { ai: 4 } }) });
  const result = await detectAi(call, "short text that nobody can score");
  assert.equal(result.aiScore, null);
  assert.equal(result.source, "none", "the chain must not fall back to guesswork");
  assert.equal(result.clean, false, "unscoreable is not clean");
  assert.deepEqual(asked, [], "nothing should be sent to a paid detector for text nobody can score");
});

console.log("\nhosted fallback: reading a score honestly");

await check("a real copyleaks body yields its percentage", async () => {
  const result = await detectHosted(callerReturning(JSON.stringify({ summary: { ai: 0.87 } })), long);
  assert.equal(result.aiScore, 87);
  assert.equal(result.source, "copyleaks");
  assert.equal(result.clean, false);
});

await check("a 0-100 body is not doubled into 8700", async () => {
  const result = await detectHosted(callerReturning(JSON.stringify({ summary: { ai: 87 } })), long);
  assert.equal(result.aiScore, 87);
});

await check("a genuine 0 from a hosted detector is clean", async () => {
  const result = await detectHosted(callerReturning(JSON.stringify({ summary: { ai: 0 } })), long);
  assert.equal(result.aiScore, 0);
  assert.equal(result.clean, true);
});

await check("a sandbox mock body never becomes a score", async () => {
  const mock = JSON.stringify({ sandbox: true, summary: { ai: 0 } });
  const result = await detectHosted(callerReturning(mock), long);
  assert.equal(result.aiScore, null, "a mock must not be scored, even when it reads 0");
  assert.equal(result.clean, false);
});

await check("unparseable output never becomes a score", async () => {
  const result = await detectHosted(callerReturning("<html>503</html>"), long);
  assert.equal(result.aiScore, null);
  assert.equal(result.clean, false);
});

await check("a percentage outside 0-100 is rejected", async () => {
  const result = await detectHosted(callerReturning(JSON.stringify({ summary: { ai: 42000 } })), long);
  assert.equal(result.aiScore, null);
});

await check("a broken copyleaks falls through to winston", async () => {
  const { call, asked } = callerSequence({
    COPYLEAKS_DETECT_AI_TEXT: JSON.stringify({ sandbox: true, summary: { ai: 0 } }),
    WINSTON_AI_AI_TEXT_DETECTION: JSON.stringify({ score: 12 }),
  });
  const result = await detectHosted(call, long);
  assert.equal(result.source, "winston");
  assert.equal(result.aiScore, 12);
  assert.deepEqual(asked, ["COPYLEAKS_DETECT_AI_TEXT", "WINSTON_AI_AI_TEXT_DETECTION"]);
});

await check("both hosted detectors failing yields null, not 0", async () => {
  const result = await detectHosted(callerSequence({}).call, long);
  assert.equal(result.aiScore, null);
  assert.equal(result.source, "none");
  assert.equal(result.clean, false);
});

await check("every hosted call asks for a fresh scan id", async () => {
  const seen: string[] = [];
  const call = async (_name: string, args: Record<string, unknown>) => {
    seen.push(String(args.scan_id));
    return JSON.stringify({ summary: { ai: 5 } });
  };
  await detectHosted(call, long);
  await detectHosted(call, long);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "a reused scan id is rejected by copyleaks as a duplicate");
});

await check("sandbox is never left at its default", async () => {
  const args: Record<string, unknown>[] = [];
  const call = async (_name: string, a: Record<string, unknown>) => {
    args.push(a);
    return JSON.stringify({ summary: { ai: 5 } });
  };
  await detectHosted(call, long);
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
