/**
 * Tests for the queue the voice agent answers delegations through.
 *
 * Two things here decide whether a caller is met with silence: every accepted
 * task must eventually run, and the tasks must not run over each other. The
 * third is the cap — past it the queue refuses rather than accepts a task whose
 * answer would arrive too late to be about anything, and a refusal has to be
 * distinguishable from an acceptance so the agent knows to answer itself.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { DelegationQueue } from "../src/delegation-queue";

let passed = 0;
let failed = 0;

// The checks here await queued work, so they are collected and waited on
// together; reporting before they settle would print a clean summary whatever
// they did.
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

/** Lets every already-resolved promise in the chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

check("runs tasks one at a time, in the order they were added", async () => {
  const queue = new DelegationQueue(5, () => {});
  const log: string[] = [];
  let running = 0;
  let overlapped = false;

  const task = (name: string, delay: number) => async () => {
    running += 1;
    if (running > 1) overlapped = true;
    log.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    log.push(`end ${name}`);
    running -= 1;
  };

  assert.equal(queue.add(task("first", 10)), true);
  assert.equal(queue.add(task("second", 1)), true);
  assert.equal(queue.add(task("third", 1)), true);

  await settle();
  // Nothing has finished yet: the chain is still on the first task's timer.
  assert.deepEqual(log, ["start first"]);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(log, [
    "start first",
    "end first",
    "start second",
    "end second",
    "start third",
    "end third",
  ]);
  assert.equal(overlapped, false);
  assert.equal(queue.size, 0);
});

check("a task that throws does not strand the tasks behind it", async () => {
  const failures: unknown[] = [];
  const queue = new DelegationQueue(5, (error) => failures.push(error));
  const log: string[] = [];

  queue.add(async () => {
    log.push("first");
    throw new Error("the backend fell over");
  });
  queue.add(async () => {
    log.push("second");
  });

  await settle();
  assert.deepEqual(log, ["first", "second"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0] instanceof Error, true);
  assert.equal((failures[0] as Error).message, "the backend fell over");
  assert.equal(queue.size, 0);
});

check("add returns false at the cap and the queue keeps draining", async () => {
  const queue = new DelegationQueue(2, () => {});
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  assert.equal(queue.add(() => held), true);
  assert.equal(queue.add(async () => {}), true);
  assert.equal(queue.size, 2);

  const refusals = ["fourth", "fifth"].map(() => queue.add(async () => {}));
  assert.deepEqual(refusals, [false, false]);
  // A refusal is not an acceptance: the depth is unchanged by it.
  assert.equal(queue.size, 2);

  release();
  await settle();
  assert.equal(queue.size, 0);

  // With room again, the queue takes work.
  assert.equal(queue.add(async () => {}), true);
  await settle();
  assert.equal(queue.size, 0);
});

check("size counts waiting and running together", async () => {
  const queue = new DelegationQueue(3, () => {});
  assert.equal(queue.size, 0);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.add(() => held);
  assert.equal(queue.size, 1);
  queue.add(async () => {});
  assert.equal(queue.size, 2);

  release();
  await settle();
  assert.equal(queue.size, 0);
});

await Promise.all(checks);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
