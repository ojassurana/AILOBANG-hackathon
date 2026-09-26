/**
 * Tests for turning a spoken name into the people it might mean.
 *
 * Two properties here decide whether the right person gets a message: who is
 * offered first, and whether anything is sent at all. "Offer the best match
 * first" is a convenience — a wrong first choice is corrected by the caller —
 * but "never send on an ambiguous name" is not, because the caller's next word
 * is "yes" and a guess between two people sends a private message to the wrong
 * one. Both are pinned here, without a socket.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import {
  MAX_CANDIDATES,
  type NamedPerson,
  describeCandidate,
  rankMatches,
  resolveSpokenName,
} from "../src/telegram-contacts";

let passed = 0;
let failed = 0;

function check(name: string, run: () => void) {
  try {
    run();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

const person = (title: string, username: string | null = null): NamedPerson => ({ title, username });

/* ----------------------------------------------------------------- matching */

check("a spoken part of a name finds the whole name", () => {
  const found = rankMatches([person("Rahul Chacha", "@rahulchacha")], "chacha", "chat");
  assert.equal(found.length, 1);
  assert.equal(found[0].title, "Rahul Chacha");
  assert.equal(found[0].username, "@rahulchacha");
  assert.equal(found[0].source, "chat");
});

check("matching ignores case and an @ the caller said anyway", () => {
  assert.equal(rankMatches([person("Rahul Chacha")], "CHACHA", "chat").length, 1);
  assert.equal(rankMatches([person("Rahul Chacha", "@rahulchacha")], "@RahulChacha", "chat").length, 1);
  assert.equal(rankMatches([person("Priya")], "  priya  ", "chat").length, 1);
});

check("the handle alone is enough to find someone", () => {
  const found = rankMatches([person("Rahul Chacha", "@rahulchacha")], "rahulchacha", "contacts");
  assert.equal(found.length, 1);
});

check("a name nobody matches yields nothing", () => {
  assert.deepEqual(rankMatches([person("Priya", "@priya")], "chacha", "chat"), []);
});

check("an empty name matches nobody rather than everybody", () => {
  assert.deepEqual(rankMatches([person("Rahul Chacha"), person("Priya")], "", "chat"), []);
  assert.deepEqual(rankMatches([person("Rahul Chacha")], "   ", "chat"), []);
  assert.deepEqual(rankMatches([person("Rahul Chacha")], "@", "chat"), []);
});

check("an exact name is offered before one that merely contains it", () => {
  const found = rankMatches(
    [person("Rahul Chacha", "@rahulchacha"), person("Chacha", "@chacha")],
    "chacha",
    "contacts",
  );
  assert.deepEqual(found.map((p) => p.title), ["Chacha", "Rahul Chacha"]);
});

check("a name that starts with the words beats one that contains them", () => {
  const found = rankMatches(
    [person("Priya Chacha", "@priyac"), person("Chacha Chacha", "@chachacha")],
    "chacha",
    "contacts",
  );
  assert.deepEqual(found.map((p) => p.title), ["Chacha Chacha", "Priya Chacha"]);
});

check("the source's own order breaks a tie", () => {
  // Stored chats arrive most recent first, so the first of two equal matches is
  // the fresher conversation.
  const found = rankMatches(
    [person("Chacha Two", "@two"), person("Chacha One", "@one")],
    "chacha",
    "chat",
  );
  assert.deepEqual(found.map((p) => p.username), ["@two", "@one"]);
});

check("the same person is offered once, however they are known", () => {
  const found = rankMatches(
    [person("Rahul Chacha", "@RahulChacha"), person("Rahul Chacha", "@rahulchacha")],
    "chacha",
    "contacts",
  );
  assert.equal(found.length, 1);
});

check("two different people with one name stay two, so the caller is asked", () => {
  const found = rankMatches([person("Rahul Chacha"), person("Priya Chacha")], "chacha", "contacts");
  assert.equal(found.length, 2);
  assert.equal(resolveSpokenName("chacha", found).kind, "refuse");
});

check("the same nameless record met twice is offered once", () => {
  // Nothing can be sent to either copy, so a second identical line would only
  // make the caller's question longer.
  const found = rankMatches([person("Chacha"), person("Chacha")], "chacha", "contacts");
  assert.equal(found.length, 1);
});

check("a person with no handle is carried through as unmessagable", () => {
  const found = rankMatches([person("Chacha")], "chacha", "contacts");
  assert.equal(found.length, 1);
  assert.equal(found[0].username, null);
});

check("no more than five are ever offered", () => {
  const many = Array.from({ length: 9 }, (_, i) => person(`Chacha ${i}`, `@chacha${i}`));
  assert.equal(rankMatches(many, "chacha", "search").length, MAX_CANDIDATES);
});

check("a record whose name is blank is not a candidate", () => {
  assert.deepEqual(rankMatches([person("   ", "@x")], "chacha", "chat"), []);
  assert.deepEqual(rankMatches([person("", "@x"), person("Chacha", "@c")], "chacha", "chat").map((p) => p.title), ["Chacha"]);
});

/* -------------------------------------------------------------- resolution */

check("one name with a handle is ready to send to", () => {
  const people = rankMatches([person("Rahul Chacha", "@rahulchacha")], "chacha", "chat");
  const settled = resolveSpokenName("chacha", people);
  assert.equal(settled.kind, "send");
  assert.deepEqual(settled, { kind: "send", username: "@rahulchacha", title: "Rahul Chacha" });
});

check("two people matching one name refuse, and name both", () => {
  const people = rankMatches(
    [person("Rahul Chacha", "@rahulchacha"), person("Priya Chacha", "@priyachacha")],
    "chacha",
    "contacts",
  );
  const settled = resolveSpokenName("chacha", people);
  assert.equal(settled.kind, "refuse");
  assert.match(settled.reason, /could be 2 people/);
  assert.match(settled.reason, /Rahul Chacha \(@rahulchacha\)/);
  assert.match(settled.reason, /Priya Chacha \(@priyachacha\)/);
  assert.match(settled.reason, /Ask the caller which one/);
});

check("a name nobody answers to refuses with what to ask for instead", () => {
  const settled = resolveSpokenName("chacha", []);
  assert.equal(settled.kind, "refuse");
  assert.match(settled.reason, /Nobody in the caller's Telegram is called "chacha"/);
  assert.match(settled.reason, /spell the @username/);
});

check("a match with no handle is refused honestly, not skipped", () => {
  const people = rankMatches([person("Chacha")], "chacha", "contacts");
  const settled = resolveSpokenName("chacha", people);
  assert.equal(settled.kind, "refuse");
  assert.match(settled.reason, /only match for "chacha" is Chacha/);
  assert.match(settled.reason, /no @username/);
  assert.match(settled.reason, /cannot be messaged/);
});

check("an unmessagable person is named in the list, not dropped from it", () => {
  const noHandle = { username: null, title: "Chacha", source: "contacts" as const };
  const withHandle = { username: "@chachacha", title: "Chacha Chacha", source: "contacts" as const };
  const settled = resolveSpokenName("chacha", [withHandle, noHandle]);
  assert.equal(settled.kind, "refuse");
  assert.match(settled.reason, /Chacha — no @username, so they cannot be messaged/);
  assert.match(settled.reason, /Chacha Chacha \(@chachacha\)/);
});

check("a candidate is described with its handle, or with why it has none", () => {
  assert.equal(
    describeCandidate({ username: "@rahulchacha", title: "Rahul Chacha", source: "chat" }),
    "Rahul Chacha (@rahulchacha)",
  );
  assert.equal(
    describeCandidate({ username: null, title: "Rahul Chacha", source: "chat" }),
    "Rahul Chacha — no @username, so they cannot be messaged",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
