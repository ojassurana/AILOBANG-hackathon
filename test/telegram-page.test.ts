/**
 * Tests for the Telegram login screen.
 *
 * The screen is a pure function of the stored status, and the states it renders
 * — a code still to type, a two-step password, a finished login — cannot be
 * reached without a real Telegram account. So the branch that decides what the
 * user is looking at is checked here, along with the escaping: the phone number
 * is user input echoed back into an attribute, and the error line is Telegram's
 * text, which is exactly the pair that must never reach the page raw.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { renderTelegramPage } from "../src/telegram-page";
import type { TelegramStatus } from "../src/telegram";

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

const base: TelegramStatus = {
  phase: "idle",
  phone: null,
  username: null,
  error: null,
  retryAt: null,
  codeViaApp: false,
  hasSession: false,
};

function screen(status: Partial<TelegramStatus>, notice?: string): string {
  return renderTelegramPage({
    email: "caller@example.com",
    status: { ...base, ...status },
    notice,
  });
}

check("a fresh screen asks for a phone number", () => {
  const html = screen({});
  assert.match(html, /action="\/telegram\/start"/);
  assert.match(html, /name="phone"/);
  assert.doesNotMatch(html, /name="code"/);
  assert.doesNotMatch(html, /name="password"/);
});

check("a pending code asks for the code and nothing else", () => {
  const html = screen({ phase: "code", phone: "+15555550123", codeViaApp: false });
  assert.match(html, /action="\/telegram\/code"/);
  assert.match(html, /name="code"/);
  assert.match(html, /autocomplete="one-time-code"/);
  assert.doesNotMatch(html, /name="phone"/);
});

check("a code sent inside Telegram says to look in Telegram, not at SMS", () => {
  // The commonest reason a code is reported as never arriving is looking in the
  // wrong place, so which channel Telegram used has to be said plainly.
  const viaApp = screen({ phase: "code", phone: "+15555550123", codeViaApp: true });
  assert.match(viaApp, /Telegram app, not by SMS/);

  const viaSms = screen({ phase: "code", phone: "+15555550123", codeViaApp: false });
  assert.match(viaSms, /by SMS to \+15555550123/);
});

check("a two-step account asks for the password", () => {
  const html = screen({ phase: "password", phone: "+15555550123" });
  assert.match(html, /action="\/telegram\/password"/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /name="code"/);
});

check("a connected account shows who is signed in and how to leave", () => {
  const html = screen({ phase: "connected", phone: "+15555550123", username: "someone" });
  assert.match(html, /@someone/);
  assert.match(html, /\+15555550123/);
  assert.match(html, /action="\/disconnect\/telegram"/);
  // Nothing left to ask for, so no step inputs at all.
  assert.doesNotMatch(html, /name="phone"/);
  assert.doesNotMatch(html, /name="code"/);
  assert.doesNotMatch(html, /name="password"/);
});

check("the stored error is the sentence shown", () => {
  const html = screen({ phase: "error", error: "That code wasn't right. Try again." });
  assert.match(html, /<p class="note bad">That code wasn&#39;t right\. Try again\.<\/p>/);
});

check("a notice replaces the stored error for a request that never went out", () => {
  const html = screen({ phase: "error", error: "stale" }, "Enter your phone number first.");
  assert.match(html, /Enter your phone number first\./);
  assert.doesNotMatch(html, /stale/);
});

check("a phone number is escaped into the input rather than injected", () => {
  // The phone is echoed into `value="..."`, so a quote in it would otherwise
  // close the attribute and let the rest of the value write markup.
  const html = screen({ phase: "error", phone: '"><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

check("an error sentence is escaped rather than trusted", () => {
  const html = screen({ phase: "error", error: '<img src=x onerror="alert(1)">' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

check("the login screen never shows a phone number it does not have", () => {
  // A blank placeholder would read as "your number is fine" when there is none.
  const html = screen({ phase: "idle", phone: null });
  assert.match(html, /value=""/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
