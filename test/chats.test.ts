/**
 * Tests for call history.
 *
 * What is load-bearing here is what the history says about a call, and who is
 * allowed to read it. A title has to be the caller's own words rather than the
 * agent's greeting; a timestamp has to stay true in a time zone the server does
 * not know; and no query may answer for a chat without naming whose it is.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import {
  absoluteWhen,
  ChatRecorder,
  chatTitle,
  clipTitle,
  countChats,
  dayGroup,
  formatDuration,
  groupByDay,
  isChatId,
  listChats,
  readChat,
  transcriptText,
  whenPhrase,
  writeChatLines,
  type ChatSummary,
} from "../src/chats";

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

/* ------------------------------------------------------------------ titles */

await check("a call is named after the caller, not after the agent's greeting", () => {
  const title = chatTitle(
    [
      { role: "assistant", text: "Hi, I can help with your connected accounts." },
      { role: "user", text: "what did Zomato invoice me for" },
    ],
    "site",
  );
  assert.equal(title, "what did Zomato invoice me for");
});

await check("a call the caller never spoke on is named after what the agent said", () => {
  const title = chatTitle([{ role: "assistant", text: "Hi, I can help with your accounts." }], "site");
  assert.equal(title, "Hi, I can help with your accounts.");
});

await check("a call with nothing in it is named after where it came from", () => {
  assert.equal(chatTitle([], "site"), "Call");
  assert.equal(chatTitle([], "phone"), "Phone call");
  assert.equal(chatTitle([{ role: "user", text: "   " }], "phone"), "Phone call");
});

await check("a title collapses the line breaks a spoken transcript arrives with", () => {
  assert.equal(clipTitle("  send   that\n\nover  "), "send that over");
});

await check("a long title is cut at a word, and marked as cut", () => {
  const title = clipTitle("please send the invoice from Zomato for last month to the accountant today");
  assert.ok(title.length <= 65, `title was ${title.length} characters`);
  assert.ok(title.endsWith("…"));
  assert.ok(title.startsWith("please send the invoice"));
  assert.ok(!title.includes("  "));
});

await check("a short title is left exactly as it was said", () => {
  assert.equal(clipTitle("bank balances"), "bank balances");
});

/* -------------------------------------------------------------- timestamps */

const NOW = new Date("2026-09-26T19:30:00Z");

await check("a call from a moment ago reads as just now", () => {
  assert.equal(whenPhrase("2026-09-26T19:29:50Z", NOW), "just now");
  assert.equal(whenPhrase("2026-09-26T19:29:00Z", NOW), "a minute ago");
  assert.equal(whenPhrase("2026-09-26T19:25:00Z", NOW), "5 minutes ago");
  assert.equal(whenPhrase("2026-09-26T18:30:00Z", NOW), "an hour ago");
  assert.equal(whenPhrase("2026-09-26T16:30:00Z", NOW), "3 hours ago");
});

await check("a call from earlier today says so rather than counting hours", () => {
  assert.equal(whenPhrase("2026-09-26T06:00:00Z", NOW), "today");
});

await check("a call from yesterday and one from earlier in the week both read plainly", () => {
  assert.equal(whenPhrase("2026-09-25T22:00:00Z", NOW), "yesterday");
  assert.equal(whenPhrase("2026-09-23T09:00:00Z", NOW), "3 days ago");
});

await check("an older call is dated, and a call from another year carries its year", () => {
  assert.equal(whenPhrase("2026-09-12T09:00:00Z", NOW), "12 Sep");
  assert.equal(whenPhrase("2025-12-31T09:00:00Z", NOW), "31 Dec 2025");
});

await check("an unparseable timestamp says nothing rather than something wrong", () => {
  assert.equal(whenPhrase("", NOW), "");
  assert.equal(whenPhrase("not a date", NOW), "");
});

await check("days are counted in UTC, so a late call is still yesterday", () => {
  assert.equal(dayGroup("2026-09-25T23:59:00Z", NOW), "Yesterday");
  assert.equal(dayGroup("2026-09-26T00:01:00Z", NOW), "Today");
  assert.equal(dayGroup("2026-09-22T12:00:00Z", NOW), "Earlier this week");
  assert.equal(dayGroup("2026-08-01T12:00:00Z", NOW), "Earlier");
});

await check("the header time names UTC rather than passing it off as the caller's clock", () => {
  assert.equal(absoluteWhen("2026-09-26T19:30:00Z"), "26 Sep 2026, 19:30 UTC");
  assert.equal(absoluteWhen("2026-09-26T04:05:00Z"), "26 Sep 2026, 04:05 UTC");
  assert.equal(absoluteWhen("nonsense"), "");
});

await check("a duration is in the units that suit it", () => {
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(90), "2 min");
  assert.equal(formatDuration(3600), "1h 0m");
  assert.equal(formatDuration(5400), "1h 30m");
});

/* ---------------------------------------------------------------- grouping */

function chat(id: string, updatedAt: string): ChatSummary {
  return {
    id,
    channel: "site",
    title: id,
    startedAt: updatedAt,
    updatedAt,
    lines: 2,
    seconds: 30,
  };
}

await check("chats are grouped under the days they belong to, newest group first", () => {
  const groups = groupByDay(
    [
      chat("a", "2026-09-26T19:00:00Z"),
      chat("b", "2026-09-26T08:00:00Z"),
      chat("c", "2026-09-25T08:00:00Z"),
      chat("d", "2026-09-21T08:00:00Z"),
      chat("e", "2026-01-01T08:00:00Z"),
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((group) => [group.label, group.chats.map((one) => one.id)]),
    [
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Earlier this week", ["d"]],
      ["Earlier", ["e"]],
    ],
  );
});

await check("a day nobody called on gets no heading", () => {
  const groups = groupByDay([chat("a", "2026-09-26T19:00:00Z"), chat("c", "2026-09-25T08:00:00Z")], NOW);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["Today", "Yesterday"],
  );
});

await check("no calls leaves no groups", () => {
  assert.deepEqual(groupByDay([], NOW), []);
});

/* ------------------------------------------------------------------- paths */

await check("only an id we could have minted is treated as one", () => {
  assert.ok(isChatId("5f1d4a2b-6c3e-4b1a-9f2d-8e7c0a1b2c3d"));
  assert.ok(!isChatId(""));
  assert.ok(!isChatId("5f1d4a2b6c3e4b1a9f2d8e7c0a1b2c3d"));
  assert.ok(!isChatId("../../etc/passwd"));
  assert.ok(!isChatId("5f1d4a2b-6c3e-4b1a-9f2d-8e7c0a1b2c3e' OR 1=1--"));
});

await check("the transcript handed to the model names both sides and drops empty lines", () => {
  assert.equal(
    transcriptText([
      { role: "user", text: "what's my balance" },
      { role: "assistant", text: "  " },
      { role: "assistant", text: "about 1,200 dollars" },
    ]),
    "Caller: what's my balance\nYou: about 1,200 dollars",
  );
});

/* -------------------------------------------------------------- ownership */

interface Recorded {
  sql: string;
  params: unknown[];
}

/** Enough of D1 to see what a query asks for, and what it is told back. */
function fakeDb(results: { first?: unknown; all?: unknown[] } = {}) {
  const seen: Recorded[] = [];
  const firsts = results.first === undefined ? [] : Array.isArray(results.first) ? [...results.first] : [results.first];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...params: unknown[]) {
          seen.push({ sql, params });
          return statement;
        },
        async first() {
          return firsts.length ? firsts.shift() : null;
        },
        async all() {
          return { results: results.all ?? [] };
        },
        async run() {
          return {};
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      return statements;
    },
  } as unknown as D1Database;
  return { db, seen };
}

/** A clock a test can move, so a call's length is decided rather than waited for. */
function testClock(start = "2026-09-26T19:00:00Z") {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const CHAT_ID = "5f1d4a2b-6c3e-4b1a-9f2d-8e7c0a1b2c3d";

function storedChat(overrides: Record<string, unknown> = {}) {
  return {
    id: CHAT_ID,
    channel: "site",
    title: "yesterday's question",
    started_at: "2026-09-25T19:00:00Z",
    updated_at: "2026-09-25T19:04:00Z",
    lines: 2,
    seconds: 240,
    ...overrides,
  };
}

const EARLIER = [
  { seq: 0, role: "user", text: "what did Zomato charge me", at: "2026-09-25T19:00:00Z" },
  { seq: 1, role: "assistant", text: "about 42 dollars", at: "2026-09-25T19:00:04Z" },
];

await check("listing calls asks only for the signed-in user's", async () => {
  const { db, seen } = fakeDb({ all: [] });
  await listChats(db, "user_a", 5);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /user_id = \?/);
  assert.deepEqual(seen[0].params, ["user_a", 5]);
});

await check("counting calls asks only for the signed-in user's", async () => {
  const { db, seen } = fakeDb({ first: { total: 7 } });
  assert.equal(await countChats(db, "user_a"), 7);
  assert.deepEqual(seen[0].params, ["user_a"]);
});

await check("reading a chat asks for it by id and user together", async () => {
  const { db, seen } = fakeDb({ first: [storedChat({ channel: "phone" })], all: EARLIER });
  const found = await readChat(db, "user_a", CHAT_ID);
  assert.ok(found);
  assert.equal(found.chat.channel, "phone");
  assert.equal(found.chat.seconds, 240);
  assert.deepEqual(
    found.lines.map((line) => line.role),
    ["user", "assistant"],
  );
  assert.deepEqual(seen[0].params, [CHAT_ID, "user_a"]);
  assert.deepEqual(seen[1].params, [CHAT_ID]);
});

await check("someone else's chat is no chat at all", async () => {
  const { db } = fakeDb({ first: [null] });
  assert.equal(await readChat(db, "user_a", CHAT_ID), null);
});

await check("a chat whose channel is not one we write is read as a site call", async () => {
  const { db } = fakeDb({ first: [storedChat({ channel: "carrier-pigeon" })], all: [] });
  const found = await readChat(db, "user_a", CHAT_ID);
  assert.equal(found?.chat.channel, "site");
});

await check("a flush writes only the tail of a growing transcript", async () => {
  const { db, seen } = fakeDb({});
  await writeChatLines(db, "chat-1", {
    lines: [
      { seq: 0, role: "user", text: "one", at: "2026-09-26T19:00:00Z" },
      { seq: 1, role: "assistant", text: "two", at: "2026-09-26T19:00:01Z" },
      { seq: 2, role: "user", text: "three", at: "2026-09-26T19:00:02Z" },
    ],
    from: 2,
    title: "one",
    updatedAt: "2026-09-26T19:00:02Z",
  });
  // The line at `from` goes again because it may still be growing; the two
  // before it do not.
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].params, ["chat-1", 2, "user", "three", "2026-09-26T19:00:02Z"]);
  assert.match(seen[1].sql, /UPDATE chats/);
  assert.deepEqual(seen[1].params, ["2026-09-26T19:00:02Z", "one", 3, "chat-1"]);
});

await check("a flush with nothing new writes nothing", async () => {
  const { db, seen } = fakeDb({});
  await writeChatLines(db, "chat-1", { lines: [], from: 0, title: "x", updatedAt: "2026-09-26T19:00:00Z" });
  assert.equal(seen.length, 0);
});

/* ------------------------------------------------------------ the recorder */

await check("a call nobody spoke on leaves nothing behind", async () => {
  const { db, seen } = fakeDb({});
  const chat = new ChatRecorder({ db, userId: "user_a", channel: "site", now: testClock().now });
  const { opened } = await chat.flush();
  assert.equal(opened, false);
  assert.equal(seen.length, 0);
  assert.ok(isChatId(chat.id));
});

await check("the first words of a call open the chat and name it", async () => {
  const { db, seen } = fakeDb({});
  const time = testClock();
  const chat = new ChatRecorder({ db, userId: "user_a", channel: "site", now: time.now });

  chat.addLine("assistant", "Hi, I can help with your connected accounts.");
  assert.equal((await chat.flush()).opened, true);
  assert.match(seen[0].sql, /INSERT INTO chats/);
  assert.deepEqual(seen[0].params, [
    chat.id,
    "user_a",
    "site",
    "Hi, I can help with your connected accounts.",
    "2026-09-26T19:00:00.000Z",
    "2026-09-26T19:00:00.000Z",
  ]);

  // The caller's first words are the better name, and replace the greeting.
  seen.length = 0;
  time.advance(2000);
  chat.addLine("user", "what did Zomato charge me");
  const second = await chat.flush();
  assert.equal(second.opened, false, "the chat was already open");
  assert.match(seen[seen.length - 1].sql, /UPDATE chats/);
  assert.equal(seen[seen.length - 1].params[1], "what did Zomato charge me");
});

await check("deltas of the same speaker are one line, not many", async () => {
  const { db } = fakeDb({});
  const chat = new ChatRecorder({ db, userId: "user_a", channel: "site", now: testClock().now });
  chat.addLine("assistant", "Bal");
  chat.addLine("assistant", "ance is ");
  chat.addLine("assistant", "fine.");
  chat.addLine("user", "thanks");
  assert.deepEqual(
    chat.spoken.map((line) => [line.role, line.text]),
    [
      ["assistant", "Balance is fine."],
      ["user", "thanks"],
    ],
  );
});

await check("a continued call adds to the chat it continues rather than opening a new one", async () => {
  const { db, seen } = fakeDb({ first: [storedChat()], all: EARLIER });
  const time = testClock();
  const chat = new ChatRecorder({ db, userId: "user_a", channel: "site", resumeId: CHAT_ID, now: time.now });
  await chat.load();

  assert.equal(chat.id, CHAT_ID);
  assert.equal(chat.continues, true);
  assert.equal(chat.resumed.length, 2);
  assert.ok(chat.resumePrompt().includes("what did Zomato charge me"));

  seen.length = 0;
  time.advance(5000);
  chat.addLine("user", "and what about yesterday");
  const { opened } = await chat.flush();

  assert.equal(opened, false, "the chat already existed");
  assert.ok(!seen.some((one) => /INSERT INTO chats/.test(one.sql)));
  // It is written after the two lines already in the chat, so continuing a call
  // cannot overwrite the conversation it continues.
  assert.deepEqual(seen[0].params, [CHAT_ID, 2, "user", "and what about yesterday", "2026-09-26T19:00:05.000Z"]);

  // The chat holds the two earlier lines as well, so the count the list shows
  // is the whole conversation rather than this call's share of it.
  const update = seen.find((one) => /UPDATE chats SET updated_at/.test(one.sql));
  assert.deepEqual(update.params, ["2026-09-26T19:00:05.000Z", "what did Zomato charge me", 3, CHAT_ID]);
});

await check("a chat that is not theirs is replaced by a new one, with no earlier lines", async () => {
  const { db, seen } = fakeDb({ first: [null] });
  const chat = new ChatRecorder({ db, userId: "user_a", channel: "site", resumeId: CHAT_ID, now: testClock().now });
  await chat.load();

  assert.equal(chat.continues, false);
  assert.notEqual(chat.id, CHAT_ID);
  assert.ok(isChatId(chat.id));
  assert.equal(chat.resumed.length, 0);
  assert.equal(chat.resumePrompt(), "");
  // Ownership is asked of the database, not assumed from the URL.
  assert.deepEqual(seen[0].params, [CHAT_ID, "user_a"]);
});

await check("a fresh call opens with no earlier conversation in it", () => {
  const { db } = fakeDb({});
  const chat = new ChatRecorder({ db, userId: "user_a", channel: "site", now: testClock().now });
  assert.equal(chat.resumePrompt(), "");
  assert.equal(chat.text(), "");
});

await check("a call's length is measured from when the chat opened, and counted once", async () => {
  const { db, seen } = fakeDb({});
  const time = testClock();
  const chat = new ChatRecorder({ db, userId: "user_a", channel: "site", now: time.now });
  chat.addLine("user", "what's my balance");
  await chat.flush();

  time.advance(90_000);
  seen.length = 0;
  assert.equal(await chat.finish(), true);
  const closed = seen.filter((one) => /ended_at/.test(one.sql));
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0].params, ["2026-09-26T19:01:30.000Z", 90, chat.id]);

  // A second finish — a teardown racing an explicit hangup — changes nothing.
  seen.length = 0;
  assert.equal(await chat.finish(), false);
  assert.equal(seen.filter((one) => /ended_at/.test(one.sql)).length, 0);
});

await check("finishing writes the last line before closing the chat", async () => {
  const { db, seen } = fakeDb({});
  const chat = new ChatRecorder({ db, userId: "user_a", channel: "site", now: testClock().now });
  await chat.flush();
  chat.addLine("user", "that's all");
  seen.length = 0;
  await chat.finish();
  const order = seen.map((one) => one.sql.replace(/\s+/g, " ").slice(0, 30));
  assert.ok(
    order.findIndex((sql) => sql.startsWith("INSERT INTO chat_lines")) <
      order.findIndex((sql) => sql.startsWith("UPDATE chats SET ended_at")),
    `line was not written before the close: ${JSON.stringify(order)}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
