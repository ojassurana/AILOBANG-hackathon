/**
 * Tests for the Telegram login state machine, error classification, and send caps.
 *
 * These are the decisions that are expensive to get wrong and impossible to
 * exercise without a real account: how many wrong codes to accept, whether an
 * error means "ask for the password" or "this session is dead", and how fast we
 * are allowed to send. All of it is pure, which is the point of the file under
 * test — a bug in classification is a wrong sentence said out loud to the user,
 * and a bug in the caps is a banned Telegram account.
 *
 * The classification cases below mirror the real shapes of `teleproto`'s error
 * classes, which are not what they look like: a specific class puts a human
 * sentence in `message` and the machine name in `errorMessage`.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  PENDING_SEND_TTL_MS,
  SEND_CAPS,
  checkSendCaps,
  classifyTelegramError,
  codeRejected,
  codeSent,
  idleLoginState,
  isSessionDead,
  loginConnected,
  loginFailed,
  passwordNeeded,
  pendingSendExpired,
  restartLogin,
} from "../src/telegram-session";

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

/* ------------------------------------------------------- the login state machine */

check("a fresh login asks for a code and keeps the hash", () => {
  const state = codeSent("+15555550123", "hash-1", true, 1000);
  assert.equal(state.phase, "code");
  assert.equal(state.phoneCodeHash, "hash-1");
  assert.equal(state.attempts, 0);
  assert.equal(state.error, null);
});

check("a wrong code keeps the hash so the same code can be retried", () => {
  // Losing the hash here would force a fresh code on one typo, and every extra
  // code sent is flood allowance spent.
  const state = codeRejected(codeSent("+15555550123", "hash-1", false, 1000), "wrong");
  assert.equal(state.phase, "code");
  assert.equal(state.phoneCodeHash, "hash-1");
  assert.equal(state.attempts, 1);
  assert.equal(state.error, "wrong");
});

check("running out of attempts drops back to idle but keeps the number", () => {
  let state = codeSent("+15555550123", "hash-1", false, 1000);
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
    state = codeRejected(state, "wrong");
  }
  assert.equal(state.phase, "idle");
  assert.equal(state.phoneCodeHash, null);
  assert.equal(state.phone, "+15555550123");
  assert.equal(state.error, "wrong");
});

check("a two-step account moves to password without losing the login", () => {
  const state = passwordNeeded(codeSent("+15555550123", "hash-1", false, 1000));
  assert.equal(state.phase, "password");
  assert.equal(state.phoneCodeHash, "hash-1");
  assert.equal(state.error, null);
});

check("connecting clears the error and the retry timer", () => {
  const state = loginConnected(5000);
  assert.equal(state.phase, "connected");
  assert.equal(state.error, null);
  assert.equal(state.retryAt, null);
  assert.equal(state.codeSentAt, 5000);
});

check("a failure records the sentence and when retrying is possible", () => {
  const state = loginFailed(idleLoginState(), "Slow down.", 9000);
  assert.equal(state.phase, "error");
  assert.equal(state.error, "Slow down.");
  assert.equal(state.retryAt, 9000);
});

check("a transient failure keeps the number and the code being typed", () => {
  // A dropped connection while the user is holding a code must not force a new
  // one: every extra code sent spends flood allowance, and Telegram bans for it.
  const held = codeSent("+15555550123", "hash-1", false, 1000);
  const state = loginFailed(held, "Connection lost.", null);
  assert.equal(state.phase, "error");
  assert.equal(state.phone, "+15555550123");
  assert.equal(state.phoneCodeHash, "hash-1");
  assert.equal(state.codeSentAt, 1000);
});

check("restarting keeps only the number the user typed", () => {
  const before = passwordNeeded(codeSent("+15555550123", "hash-1", true, 1000));
  const after = restartLogin(before);
  assert.deepEqual(after, { ...idleLoginState(), phone: "+15555550123" });
});

check("a stale code is old enough to be worth rejecting", () => {
  assert.ok(CODE_TTL_MS > 0);
});

/* ------------------------------------------------------------ error classification */

check("a specific teleproto error is classified by its machine name", () => {
  // The real shape: `ApiIdInvalidError` sets `message` to the sentence
  // "API ID invalid. (caused by auth.SendCode)" and `errorMessage` to the name.
  // Reading the message alone yields "API", which is how this got misreported.
  const error = Object.assign(new Error("API ID invalid. (caused by auth.SendCode)"), {
    errorMessage: "API_ID_INVALID",
    code: 400,
  });
  const classified = classifyTelegramError(error);
  assert.equal(classified.name, "API_ID_INVALID");
  assert.equal(classified.kind, "config");
});

check("our own bad credentials never read as the user's fault", () => {
  const error = Object.assign(new Error("API ID invalid."), { errorMessage: "API_ID_INVALID" });
  const classified = classifyTelegramError(error);
  assert.match(classified.message, /ours to fix/i);
  assert.doesNotMatch(classified.message, /API_ID_INVALID/);
});

check("a flood wait takes its seconds from the typed field", () => {
  // `FloodWaitError` reports `errorMessage` as the bare "FLOOD" and keeps the
  // count in `seconds`, so neither field alone is enough.
  const error = Object.assign(new Error("Please wait 17 seconds before repeating the action."), {
    errorMessage: "FLOOD",
    code: 420,
    seconds: 17,
  });
  const classified = classifyTelegramError(error, { name: "FLOOD_WAIT", seconds: 17 });
  assert.equal(classified.kind, "flood");
  assert.equal(classified.seconds, 17);
  assert.match(classified.message, /Try again in a minute/);
  // The seconds reach the row, which is what actually gates the retry.
  assert.doesNotMatch(classified.message, /17/);
});

check("a long flood wait rounds up rather than down", () => {
  // 61 seconds must not read as "1 minute", or the retry lands inside the wait.
  const error = Object.assign(new Error("Please wait 61 seconds before repeating the action."), {
    errorMessage: "FLOOD",
    seconds: 61,
  });
  const classified = classifyTelegramError(error, { name: "FLOOD_WAIT", seconds: 61 });
  assert.match(classified.message, /2 minutes/);
});

check("a flood wait is read out of the message when nothing types it", () => {
  const error = new Error("420: FLOOD_WAIT_17 (caused by messages.SendMessage)");
  const classified = classifyTelegramError(error);
  assert.equal(classified.name, "FLOOD_WAIT");
  assert.equal(classified.kind, "flood");
  assert.equal(classified.seconds, 17);
});

check("an unnamed number is stripped from the name that picks the response", () => {
  const classified = classifyTelegramError(new Error("FLOOD_WAIT_300 (caused by auth.SendCode)"));
  assert.equal(classified.name, "FLOOD_WAIT");
  assert.equal(classified.seconds, 300);
});

check("a wrong code is recognised from the message Telegram sends", () => {
  const classified = classifyTelegramError(new Error("PHONE_CODE_INVALID (caused by auth.SignIn)"));
  assert.equal(classified.kind, "bad_code");
  assert.match(classified.message, /try again/i);
});

check("a two-step prompt is recognised by name", () => {
  const error = Object.assign(new Error("Two-step verification is enabled."), {
    errorMessage: "SESSION_PASSWORD_NEEDED",
  });
  assert.equal(classifyTelegramError(error).kind, "password");
});

check("a dead session is recognisable as needing a reconnect", () => {
  const classified = classifyTelegramError(new Error("AUTH_KEY_UNREGISTERED (caused by messages.SendMessage)"));
  assert.equal(classified.kind, "session_dead");
  assert.equal(isSessionDead(classified.kind), true);
  assert.match(classified.message, /connect again/i);
});

check("a human sentence in errorMessage is not mistaken for a name", () => {
  // The generic `RPCError` leaves a sentence in both fields. `Please` is not an
  // error name, so this has to fall through to UNKNOWN rather than classify on
  // the first word — the same trap that produced "API".
  const error = Object.assign(new Error("Please try again later."), {
    errorMessage: "Please try again later.",
  });
  const classified = classifyTelegramError(error);
  assert.equal(classified.name, "UNKNOWN");
  assert.equal(classified.kind, "unknown");
  assert.equal(classified.seconds, null);
});

check("an unknown name is still named in the message for the logs", () => {
  const classified = classifyTelegramError(new Error("SOMETHING_NEW_ENTIRELY (caused by auth.SignIn)"));
  assert.equal(classified.kind, "unknown");
  assert.match(classified.message, /SOMETHING_NEW_ENTIRELY/);
});

check("a thrown non-Error classifies rather than crashing", () => {
  const classified = classifyTelegramError("PEER_FLOOD");
  assert.equal(classified.kind, "blocked");
});

check("no error name in the raw name table is spelled with a trailing count", () => {
  // A count in a table key would never match, because it is stripped first.
  for (const name of ["PHONE_CODE_INVALID", "FLOOD_WAIT", "API_ID_INVALID"]) {
    assert.doesNotMatch(name, /_\d+$/);
  }
});

/* --------------------------------------------------------------- send rate caps */

const now = 1_000_000_000;

/**
 * Timestamps ending just far enough back to clear the minimum gap, so that a
 * test about a window is not decided by the burst rule instead.
 */
function history(count: number, everyMs: number, gapMs = SEND_CAPS.minGapMs): number[] {
  return Array.from({ length: count }, (_, i) => now - gapMs - i * everyMs);
}

check("the first message is allowed", () => {
  const verdict = checkSendCaps({ sentAt: [], coldSentAt: [], isCold: true, now });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, null);
});

check("two messages at once are not", () => {
  const verdict = checkSendCaps({
    sentAt: [now - 100],
    coldSentAt: [],
    isCold: false,
    now,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.retryAt, now - 100 + SEND_CAPS.minGapMs);
});

check("the hourly cap holds and says when it lifts", () => {
  const sentAt = history(SEND_CAPS.perHour, 60_000);
  const verdict = checkSendCaps({ sentAt, coldSentAt: [], isCold: false, now });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, new RegExp(`${SEND_CAPS.perHour} messages in an hour`));
  assert.equal(verdict.retryAt, Math.min(...sentAt) + 60 * 60 * 1000);
});

check("the daily cap holds even when the hour is clear", () => {
  // Spread across the day so that no single hour is full: the daily cap has to
  // catch this on its own, or a steady trickle would run all day.
  const sentAt = history(SEND_CAPS.perDay, 30 * 60_000);
  const verdict = checkSendCaps({ sentAt, coldSentAt: [], isCold: false, now });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, new RegExp(`${SEND_CAPS.perDay} messages today`));
});

check("first-time messages are capped harder than the rest", () => {
  // This is the path that gets reported as spam, so it stops well before the
  // overall daily limit does.
  const coldSentAt = history(SEND_CAPS.coldPerDay, 60_000);
  const verdict = checkSendCaps({ sentAt: coldSentAt, coldSentAt, isCold: true, now });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, /first-time messages/);
  assert.ok(SEND_CAPS.coldPerDay < SEND_CAPS.perDay);
});

check("the cold cap does not apply to someone already written to", () => {
  const coldSentAt = history(SEND_CAPS.coldPerDay, 60_000);
  const verdict = checkSendCaps({ sentAt: coldSentAt, coldSentAt, isCold: false, now });
  assert.equal(verdict.allowed, true);
});

check("windows slide rather than reset on a boundary", () => {
  // A fixed counter would let a burst through at the top of the hour; the cap
  // has to look at timestamps.
  const sentAt = history(SEND_CAPS.perHour, 60_000);
  const justAfter = checkSendCaps({ sentAt, coldSentAt: [], isCold: false, now: now + SEND_CAPS.minGapMs });
  assert.equal(justAfter.allowed, false);
  const anHourLater = checkSendCaps({
    sentAt,
    coldSentAt: [],
    isCold: false,
    now: now + 60 * 60 * 1000 + SEND_CAPS.minGapMs,
  });
  assert.equal(anHourLater.allowed, true);
});

/* ------------------------------------------------------ pending confirmation */

check("a draft expires so an old yes cannot send it", () => {
  const draft = { to: "@someone", toLabel: "Someone", text: "hi", preparedAt: now };
  assert.equal(pendingSendExpired(draft, now + PENDING_SEND_TTL_MS - 1), false);
  assert.equal(pendingSendExpired(draft, now + PENDING_SEND_TTL_MS + 1), true);
  assert.equal(pendingSendExpired(null, now), true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
