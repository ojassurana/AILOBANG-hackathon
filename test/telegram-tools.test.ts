/**
 * Tests for the Telegram tools the harness calls.
 *
 * These are the model's only way to reach the caller's Telegram account, so what
 * they say when there is no connection matters as much as what they do when
 * there is: an empty inbox reported to a model reads as "nobody has messaged
 * you" and gets said out loud. Every state is exercised against a fake object,
 * which is why the tools take an interface rather than the real Durable Object.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { TELEGRAM_TOOLS, TelegramToolbox, isTelegramTool, type TelegramActions } from "../src/telegram-tools";
import type { ChatSummary, MessageLine, PrepareResult, SendResult, TelegramStatus } from "../src/telegram";
import type { ContactCandidate } from "../src/telegram-contacts";

let passed = 0;
let failed = 0;

// The checks here await a fake object, so they are collected and waited on
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

const CONNECTED: TelegramStatus = {
  phase: "connected",
  phone: "+15555550123",
  username: "caller",
  error: null,
  retryAt: null,
  codeViaApp: false,
  hasSession: true,
};

interface Recorded {
  listChats: number[];
  readMessages: { chat: string; limit: number | undefined }[];
  lookups: string[];
  prepared: { to: string; text: string }[];
  sends: number;
}

function fake(options: {
  status?: Partial<TelegramStatus>;
  chats?: ChatSummary[];
  messages?: MessageLine[];
  contacts?: ContactCandidate[];
  prepare?: Partial<PrepareResult>;
  send?: Partial<SendResult>;
} = {}) {
  const recorded: Recorded = { listChats: [], readMessages: [], lookups: [], prepared: [], sends: 0 };

  const telegram: TelegramActions = {
    async status() {
      return { ...CONNECTED, ...options.status };
    },
    async listChats(limit?: number) {
      recorded.listChats.push(limit ?? -1);
      return options.chats ?? [];
    },
    async readMessages(chat: string, limit?: number) {
      recorded.readMessages.push({ chat, limit });
      return options.messages ?? [];
    },
    async findContacts(name: string) {
      recorded.lookups.push(name);
      return options.contacts ?? [];
    },
    async prepareSend(to: string, text: string) {
      recorded.prepared.push({ to, text });
      return {
        ok: true,
        reason: null,
        to: to.startsWith("@") ? to : `@${to}`,
        title: "Himanshu",
        text,
        ...options.prepare,
      };
    },
    async sendPending() {
      recorded.sends += 1;
      return { ok: true, reason: null, to: "@himanshu", title: "Himanshu", ...options.send };
    },
  };

  return { toolbox: new TelegramToolbox(telegram), recorded, telegram };
}

/* ------------------------------------------------------------------ gating */

check("every tool refuses to act without a connection, and says so", async () => {
  for (const only of [{ phase: "idle" as const, hasSession: false }, { phase: "error" as const, error: "Telegram is asking us to slow down." }]) {
    const { toolbox, recorded } = fake({ status: only });
    for (const tool of TELEGRAM_TOOLS) {
      const answer = await toolbox.run(tool.function.name, '{"chat":"@x","to":"@x","text":"hi"}');
      assert.match(answer, /Telegram isn't connected|isn't usable right now/);
    }
    // Nothing reached the object: the refusal is decided before any read.
    assert.deepEqual(recorded.prepared, []);
    assert.equal(recorded.sends, 0);
    assert.deepEqual(recorded.listChats, []);
    assert.deepEqual(recorded.lookups, []);
  }
});

check("a half-finished login points at the code, not at connecting", async () => {
  const { toolbox } = fake({ status: { phase: "code", hasSession: false } });
  const answer = await toolbox.run("telegram_list_chats", "{}");
  assert.match(answer, /login isn't finished/);
  assert.doesNotMatch(answer, /connect it from the Telegram row/);
});

check("an unknown tool name is reported rather than thrown", async () => {
  const { toolbox } = fake();
  assert.equal(await toolbox.run("telegram_do_something", "{}"), "There is no Telegram tool called telegram_do_something.");
  assert.equal(isTelegramTool("telegram_read_messages"), true);
  assert.equal(isTelegramTool("COMPOSIO_SEARCH_TOOLS"), false);
});

/* ------------------------------------------------------------------ reading */

check("an empty inbox is reported as empty, not as hidden history", async () => {
  const { toolbox } = fake({ chats: [] });
  const answer = await toolbox.run("telegram_list_chats", "{}");
  assert.match(answer, /Nothing has arrived/);
  assert.match(answer, /rather than suggesting there may be older messages/);
});

check("chats are listed with who has written and when", async () => {
  const { toolbox, recorded } = fake({
    chats: [
      { chat: "user:1", title: "@himanshu", lastMessageAt: 1_700_000_000_000, unreadFromThem: 2 },
      { chat: "user:2", title: "Priya", lastMessageAt: 1_699_000_000_000, unreadFromThem: 0 },
    ],
  });
  const answer = await toolbox.run("telegram_list_chats", '{"limit": 3}');
  assert.match(answer, /\[@himanshu\] 2 from them/);
  assert.match(answer, /\[Priya\] 0 from them/);
  assert.deepEqual(recorded.listChats, [3]);
});

check("a chat with nothing stored says which of the two reasons it is", async () => {
  const { toolbox } = fake({ messages: [] });
  const answer = await toolbox.run("telegram_read_messages", '{"chat":"@himanshu"}');
  assert.match(answer, /Nothing is stored for "@himanshu"/);
  assert.match(answer, /telegram_list_chats/);
});

check("reading needs a chat to read", async () => {
  const { toolbox, recorded } = fake();
  const answer = await toolbox.run("telegram_read_messages", "{}");
  assert.match(answer, /Give telegram_read_messages the chat to read/);
  assert.deepEqual(recorded.readMessages, []);
});

check("messages are labelled by who sent them, oldest first", async () => {
  const { toolbox } = fake({
    messages: [
      { from: "@himanshu", outgoing: false, text: "Are you coming?", at: 1_700_000_000_000 },
      { from: "you", outgoing: true, text: "On my way", at: 1_700_000_060_000 },
    ],
  });
  const answer = await toolbox.run("telegram_read_messages", '{"chat":"@himanshu"}');
  assert.match(answer, /@himanshu: Are you coming\?/);
  assert.match(answer, /Caller: On my way/);
  assert.ok(answer.indexOf("Are you coming?") < answer.indexOf("On my way"));
});

check("a count from the model is held to what a spoken answer can carry", async () => {
  const { toolbox, recorded } = fake();
  await toolbox.run("telegram_list_chats", '{"limit": 4000}');
  await toolbox.run("telegram_read_messages", '{"chat":"@x","limit":0}');
  await toolbox.run("telegram_list_chats", '{"limit":"lots"}');
  assert.deepEqual(recorded.listChats, [50, 20]);
  assert.equal(recorded.readMessages[0].limit, 1);
});

/* ---------------------------------------------------------------- finding */

const found = (title: string, username: string | null, source: ContactCandidate["source"] = "chat"): ContactCandidate =>
  ({ title, username, source });

check("one match names the handle to send to, rather than guessing", async () => {
  const { toolbox, recorded } = fake({ contacts: [found("Rahul Chacha", "@rahulchacha")] });
  const answer = await toolbox.run("telegram_find_contact", '{"name":"Chacha"}');
  assert.match(answer, /One person matches "Chacha"/);
  assert.match(answer, /Rahul Chacha \(@rahulchacha\)/);
  assert.match(answer, /Send to @rahulchacha/);
  // The name is looked up as the caller said it, not tidied into a handle first.
  assert.deepEqual(recorded.lookups, ["Chacha"]);
});

check("several matches become a question, never a choice", async () => {
  const { toolbox } = fake({
    contacts: [found("Rahul Chacha", "@rahulchacha"), found("Priya Chacha", "@priyachacha", "contacts")],
  });
  const answer = await toolbox.run("telegram_find_contact", '{"name":"chacha"}');
  assert.match(answer, /Several people match "chacha"/);
  assert.match(answer, /1\. Rahul Chacha \(@rahulchacha\)/);
  assert.match(answer, /2\. Priya Chacha \(@priyachacha\)/);
  assert.match(answer, /Ask the caller which one they mean/);
  assert.match(answer, /do not pick one yourself/);
});

check("a name nobody matches is reported, with what to ask for instead", async () => {
  const { toolbox } = fake({ contacts: [] });
  const answer = await toolbox.run("telegram_find_contact", '{"name":"Chacha"}');
  assert.match(answer, /Nobody in the caller's Telegram matches "Chacha"/);
  assert.match(answer, /spell the @username/);
});

check("a person who cannot be messaged is reported as such, not dropped", async () => {
  const { toolbox } = fake({ contacts: [found("Chacha", null)] });
  const answer = await toolbox.run("telegram_find_contact", '{"name":"Chacha"}');
  assert.match(answer, /One person matches "Chacha"/);
  assert.match(answer, /no @username, so they cannot be messaged/);
  assert.match(answer, /cannot be messaged: Telegram needs a handle/);
  assert.doesNotMatch(answer, /Send to/);
});

check("a match says where it was found, so a stranger is not read as a friend", async () => {
  const { toolbox } = fake({ contacts: [found("Chacha", "@chacha", "search")] });
  const answer = await toolbox.run("telegram_find_contact", '{"name":"chacha"}');
  assert.match(answer, /came up in Telegram search/);
});

check("finding needs a name to look up", async () => {
  const { toolbox, recorded } = fake();
  assert.match(await toolbox.run("telegram_find_contact", "{}"), /the name the caller said/);
  assert.deepEqual(recorded.lookups, []);
});

check("a resolved name is what gets read back before anything is sent", async () => {
  const { toolbox, recorded } = fake({
    prepare: { ok: true, reason: null, to: "@rahulchacha", title: "Rahul Chacha", text: "On my way" },
  });
  const answer = await toolbox.run("telegram_prepare_send", '{"to":"Chacha","text":"On my way"}');
  assert.match(answer, /To: Rahul Chacha \(@rahulchacha\)/);
  // The name went through as spoken; resolving it is the object's job, not the
  // tool's, so the handle in the answer is the one that will be sent to.
  assert.deepEqual(recorded.prepared, [{ to: "Chacha", text: "On my way" }]);
  assert.equal(recorded.sends, 0);
});

check("a refusal naming several people reaches the model with the candidates intact", async () => {
  // What produces this string — one match or none, never a choice between two —
  // is pinned in telegram-contacts.test.ts, where the rule lives. What matters
  // here is that the sentence and the candidates survive the tool boundary, and
  // that a refused preparation sends nothing.
  const { toolbox, recorded } = fake({
    prepare: {
      ok: false,
      reason:
        "chacha could be 2 people: Rahul Chacha (@rahulchacha), Priya Chacha (@priyachacha). " +
        "Ask the caller which one they mean, then prepare the message again with that person's @username.",
      to: null,
      title: null,
      text: null,
    },
  });
  const answer = await toolbox.run("telegram_prepare_send", '{"to":"chacha","text":"hi"}');
  assert.match(answer, /could be 2 people/);
  assert.match(answer, /@rahulchacha/);
  assert.match(answer, /@priyachacha/);
  assert.match(answer, /Ask the caller which one they mean/);
  assert.equal(recorded.sends, 0);
});

/* ------------------------------------------------------------------ sending */

check("preparing a message sends nothing and asks for a confirmation", async () => {
  const { toolbox, recorded } = fake();
  const answer = await toolbox.run(
    "telegram_prepare_send",
    '{"to":"@himanshu","text":"It is time to collect the chair."}',
  );
  assert.match(answer, /Prepared, and NOT sent yet/);
  assert.match(answer, /It is time to collect the chair\./);
  assert.match(answer, /Call telegram_confirm_send only after they say yes/);
  assert.deepEqual(recorded.prepared, [{ to: "@himanshu", text: "It is time to collect the chair." }]);
  assert.equal(recorded.sends, 0);
});

check("preparing needs both a recipient and the text", async () => {
  const { toolbox, recorded } = fake();
  assert.match(await toolbox.run("telegram_prepare_send", '{"text":"hi"}'), /who to send to/);
  assert.match(await toolbox.run("telegram_prepare_send", '{"to":"@himanshu"}'), /exact message text/);
  assert.match(await toolbox.run("telegram_prepare_send", "{}"), /who to send to/);
  assert.deepEqual(recorded.prepared, []);
});

check("a refused preparation passes the reason through unchanged", async () => {
  const { toolbox, recorded } = fake({
    prepare: { ok: false, reason: "Telegram is asking us to slow down. Try again in a minute.", to: null, title: null, text: null },
  });
  const answer = await toolbox.run("telegram_prepare_send", '{"to":"@himanshu","text":"hi"}');
  assert.equal(answer, "Telegram is asking us to slow down. Try again in a minute.");
  assert.equal(recorded.sends, 0);
});

check("confirming sends exactly the prepared message and reports who it went to", async () => {
  const { toolbox, recorded } = fake();
  const answer = await toolbox.run("telegram_confirm_send", "{}");
  assert.equal(answer, "Sent to Himanshu (@himanshu).");
  assert.equal(recorded.sends, 1);
});

check("a send that did not happen is never reported as sent", async () => {
  const { toolbox } = fake({
    send: { ok: false, reason: "That message is no longer waiting to go — ask me to send it again." },
  });
  const answer = await toolbox.run("telegram_confirm_send", "{}");
  assert.equal(answer, "That message is no longer waiting to go — ask me to send it again.");
  assert.doesNotMatch(answer, /^Sent/);
});

/* ------------------------------------------------------------------- schema */

check("every tool is named and described for the model that has to choose it", () => {
  const names = TELEGRAM_TOOLS.map((tool) => tool.function.name);
  assert.deepEqual(names, [
    "telegram_list_chats",
    "telegram_read_messages",
    "telegram_find_contact",
    "telegram_prepare_send",
    "telegram_confirm_send",
  ]);
  for (const tool of TELEGRAM_TOOLS) {
    assert.ok((tool.function.description ?? "").length > 80, `${tool.function.name} needs a description`);
    assert.equal(tool.type, "function");
    assert.ok(tool.function.parameters, `${tool.function.name} needs a parameters object`);
  }
});

check("the harness prompt tells the model how to use each tool it is given", async () => {
  const { SYSTEM_PROMPT } = await import("../src/harness");
  for (const tool of TELEGRAM_TOOLS) {
    assert.ok(SYSTEM_PROMPT.includes(tool.function.name), `the prompt never mentions ${tool.function.name}`);
  }
  // The two-step send is the part a model gets wrong by sending on the first call.
  assert.match(SYSTEM_PROMPT, /both are required/);
  assert.match(SYSTEM_PROMPT, /only after they say yes/i);
});

await Promise.all(checks);
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
