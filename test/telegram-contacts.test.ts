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
  type SendTarget,
  addressUserId,
  describeCandidate,
  freshIdentity,
  rankMatches,
  resolveSpokenName,
  sendAddress,
  sendKey,
  spokenAddress,
  storedPeople,
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

const person = (
  title: string,
  username: string | null = null,
  userId: string | null = null,
  accessHash: string | null = null,
): NamedPerson => ({ title, username, userId, accessHash });

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

check("a person with no handle is carried through as a candidate", () => {
  const found = rankMatches([person("Chacha")], "chacha", "contacts");
  assert.equal(found.length, 1);
  assert.equal(found[0].username, null);
});

check("two accounts with one name stay two, even with no handles", () => {
  // Two different Telegram accounts with the same display name and no username:
  // distinct ids, so this is two people and the caller is asked.
  const found = rankMatches(
    [person("Anshu", null, "42", "h1"), person("Anshu", null, "43", "h2")],
    "anshu",
    "contacts",
  );
  assert.equal(found.length, 2);
  assert.equal(resolveSpokenName("anshu", found).kind, "refuse");
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
  assert.deepEqual(settled, {
    kind: "send",
    target: { title: "Rahul Chacha", username: "@rahulchacha", userId: null, accessHash: null },
  });
});

check("a name with no handle is sendable too, by the id the lookup carried", () => {
  const people = rankMatches(
    [person("Himanshu Sharma", null, "42", "7301234567890123456")],
    "himanshu",
    "contacts",
  );
  const settled = resolveSpokenName("himanshu", people);
  assert.equal(settled.kind, "send");
  if (settled.kind !== "send") return;
  assert.equal(settled.target.title, "Himanshu Sharma");
  assert.equal(settled.target.userId, "42");
  assert.equal(settled.target.username, null);
  assert.equal(sendAddress(settled.target), "id:42");
});

check("a stored chat with no hash yet is still sendable", () => {
  // The chat source knows an id from the message table and no access hash at
  // all; the hash is fetched when the message actually goes, not here.
  const people = rankMatches([person("Himanshu Sharma", null, "42", null)], "himanshu", "chat");
  const settled = resolveSpokenName("himanshu", people);
  assert.equal(settled.kind, "send");
  if (settled.kind !== "send") return;
  assert.equal(settled.target.accessHash, null);
  assert.equal(sendAddress(settled.target), "id:42");
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
  assert.match(settled.reason, /a handle is not needed to look someone up/);
  assert.doesNotMatch(settled.reason, /spell the @username|needs a handle/);
});

check("a candidate with neither a handle nor an id is refused defensively", () => {
  // No lookup source produces this — each one that names a person also gives an
  // id — but a name with nothing to send to must not become a promise.
  const people = rankMatches([person("Chacha")], "chacha", "chat");
  const settled = resolveSpokenName("chacha", people);
  assert.equal(settled.kind, "refuse");
  assert.match(settled.reason, /The only match for "chacha" is Chacha/);
  assert.match(settled.reason, /neither a handle nor an account id/);
  assert.doesNotMatch(settled.reason, /Telegram needs a/);
});

check("a person with no handle is named in the list, not dropped from it", () => {
  const noHandle = { username: null, title: "Chacha", source: "contacts" as const, userId: "42", accessHash: null };
  const withHandle = { username: "@chachacha", title: "Chacha Chacha", source: "contacts" as const, userId: null, accessHash: null };
  const settled = resolveSpokenName("chacha", [withHandle, noHandle]);
  assert.equal(settled.kind, "refuse");
  assert.match(settled.reason, /Chacha — no @username/);
  assert.match(settled.reason, /Chacha Chacha \(@chachacha\)/);
  assert.doesNotMatch(settled.reason, /cannot be messaged/);
});

check("a candidate is described with its handle, or with the handle it lacks", () => {
  assert.equal(
    describeCandidate({ username: "@rahulchacha", title: "Rahul Chacha", source: "chat", userId: null, accessHash: null }),
    "Rahul Chacha (@rahulchacha)",
  );
  assert.equal(
    describeCandidate({ username: null, title: "Rahul Chacha", source: "chat", userId: "42", accessHash: "hash" }),
    "Rahul Chacha — no @username",
  );
});

/* ------------------------------------------------------- sending by account */

check("an address is the handle, or the id when there is no handle", () => {
  assert.equal(sendAddress({ username: "@rahulchacha", userId: "42" }), "@rahulchacha");
  assert.equal(sendAddress({ username: null, userId: "42" }), "id:42");
});

check("a stored address carries the id and never the hash", () => {
  const target: SendTarget = {
    title: "Chacha",
    username: null,
    userId: "42",
    accessHash: "7301234567890123456",
  };
  const address = sendAddress(target);
  assert.equal(address, "id:42");
  // The hash is what makes the id usable and what expires; it is not in the one
  // string the pending send survives on.
  assert.doesNotMatch(address, /7301234567890123456/);
  assert.equal(addressUserId(address), "42");
  assert.equal(addressUserId("@rahulchacha"), null);
  assert.equal(spokenAddress(address), null);
  assert.equal(spokenAddress("@rahulchacha"), "@rahulchacha");
});

check("one person is one row in the send tables however they were reached", () => {
  assert.equal(sendKey("@RahulChacha"), "rahulchacha");
  assert.equal(sendKey("rahulchacha"), "rahulchacha");
  assert.equal(sendKey("id:42"), "id:42");
});

check("a username match still sends by handle, id or no id", () => {
  const people = rankMatches(
    [person("Rahul Chacha", "@rahulchacha", "42", "hash")],
    "chacha",
    "contacts",
  );
  const settled = resolveSpokenName("chacha", people);
  assert.equal(settled.kind, "send");
  if (settled.kind !== "send") return;
  assert.equal(sendAddress(settled.target), "@rahulchacha");
  assert.equal(addressUserId(sendAddress(settled.target)), null);
  assert.equal(sendKey(sendAddress(settled.target)), "rahulchacha");
});

check("a send uses the hash the lookup just returned, and nothing else", () => {
  const atPrepare: SendTarget = {
    title: "Chacha",
    username: null,
    userId: "42",
    accessHash: "hash-from-prepare",
  };
  const address = sendAddress(atPrepare);
  // The fresh lookup is the only place a hash can come from: it is handed the id
  // the draft kept and the people a live lookup has just returned.
  const again = freshIdentity(addressUserId(address)!, [
    person("Chacha", null, "42", "hash-from-this-lookup"),
  ]);
  assert.deepEqual(again, { userId: "42", accessHash: "hash-from-this-lookup" });
  assert.notEqual(again?.accessHash, atPrepare.accessHash);
});

check("an id the fresh lookup does not know sends nothing", () => {
  assert.equal(freshIdentity("42", []), null);
  assert.equal(freshIdentity("42", [person("Chacha", null, "43", "someone-else")]), null);
  // A user this lookup returned without a usable hash is not addressable either.
  assert.equal(freshIdentity("42", [person("Chacha", null, "42", null)]), null);
});

check("the message table's rows become one person per name, with what each row knows", () => {
  // One person, two chat keys: a message we sent is stored under the handle and
  // one that arrived under the id.
  const people = storedPeople([
    { chat: "user:rahulchacha", title: "Rahul Chacha" },
    { chat: "user:42", title: "Rahul Chacha" },
    { chat: "user:43", title: "Anshu" },
  ]);
  assert.equal(people.length, 2);
  assert.deepEqual(people[0], {
    title: "Rahul Chacha",
    username: "@rahulchacha",
    userId: "42",
    accessHash: null,
  });
  assert.deepEqual(people[1], {
    title: "Anshu",
    username: null,
    userId: "43",
    accessHash: null,
  });
  // No hash is ever recovered from storage.
  assert.deepEqual(people.map((one) => one.accessHash), [null, null]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
