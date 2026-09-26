/**
 * Linking a phone number to an account, and finding the account behind a call.
 *
 * A number is proven by a six-digit code read out in a call from the site's
 * Telnyx number.
 * Once linked it stays linked: a call from that number reaches the owner's
 * voice agent and, through it, their connected accounts, so the link is not
 * something to hand out or swap casually.
 */

import type { Env } from "./env";
import { callWithCode } from "./telnyx";

/** How long a code stays usable. */
export const CODE_TTL_SECONDS = 10 * 60;
/** The shortest gap between two code calls to the same user. */
export const RESEND_AFTER_SECONDS = 30;
const SEND_WINDOW_SECONDS = 60 * 60;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_ATTEMPTS = 5;

export interface PhoneLink {
  phone: string;
  linkedAt: string;
}

export interface PendingCode {
  phone: string;
  expiresAt: number;
}

export type PhoneResult = { ok: true } | { ok: false; message: string };

/**
 * A typed number in E.164 (`+` and 8–15 digits), or null.
 *
 * Spaces, dashes, dots and brackets are dropped, and a leading `00` is read as
 * the international prefix. A number with no country code is refused rather
 * than guessed at: guessing wrong phones a stranger with a code.
 */
export function normalizePhone(input: string): string | null {
  let value = input.trim().replace(/[\s\-().]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return null;
  return value;
}

/**
 * The caller's number from a SIP header value, in E.164, or null.
 *
 * Takes the user part of the first `sip:`/`sips:`/`tel:` URI, e.g.
 * `"Name" <sip:+14155550123@1.2.3.4>;tag=x`. Carriers differ on the plus, so a
 * bare run of digits is read as already carrying its country code.
 */
export function phoneFromSipHeader(value: string): string | null {
  const match = /(?:sips?|tel):([^@;>\s]+)/i.exec(value);
  if (!match) return null;
  const user = decodeURIComponent(match[1]);
  if (/^\d{8,15}$/.test(user)) return normalizePhone(`+${user}`);
  return normalizePhone(user);
}

/** A number laid out for reading: `+1 407 358 0773` for North America, as-is otherwise. */
export function formatPhone(e164: string): string {
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return nanp ? `+1 ${nanp[1]} ${nanp[2]} ${nanp[3]}` : e164;
}

export async function getPhoneLink(db: D1Database, userId: string): Promise<PhoneLink | null> {
  const row = await db
    .prepare("SELECT phone_number, linked_at FROM phone_links WHERE user_id = ?")
    .bind(userId)
    .first<{ phone_number: string; linked_at: string }>();
  return row ? { phone: row.phone_number, linkedAt: row.linked_at } : null;
}

export async function userForPhone(db: D1Database, phone: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM phone_links WHERE phone_number = ?")
    .bind(phone)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function pendingCode(db: D1Database, userId: string): Promise<PendingCode | null> {
  const row = await db
    .prepare("SELECT phone_number, expires_at, attempts FROM phone_codes WHERE user_id = ?")
    .bind(userId)
    .first<{ phone_number: string; expires_at: number; attempts: number }>();
  if (!row || row.expires_at <= now() || row.attempts >= MAX_ATTEMPTS) return null;
  return { phone: row.phone_number, expiresAt: row.expires_at };
}

/** Calls `input` with a fresh code, replacing any code the user was waiting on. */
export async function sendLinkCode(env: Env, userId: string, input: string): Promise<PhoneResult> {
  const phone = normalizePhone(input);
  if (!phone) {
    return { ok: false, message: "Enter the full number with its country code, like +1 415 555 0123." };
  }
  if (phone === env.TELNYX_PHONE_NUMBER) {
    return { ok: false, message: "That's Ailobang's own number. Enter yours." };
  }

  if (await getPhoneLink(env.DB, userId)) {
    return { ok: false, message: "Your account already has a linked number." };
  }
  if (await userForPhone(env.DB, phone)) {
    return { ok: false, message: "That number is already linked to another account." };
  }

  const current = await env.DB.prepare(
    "SELECT sent_at, window_start, sends_in_window FROM phone_codes WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ sent_at: number; window_start: number; sends_in_window: number }>();

  const at = now();
  if (current && at - current.sent_at < RESEND_AFTER_SECONDS) {
    const wait = RESEND_AFTER_SECONDS - (at - current.sent_at);
    return { ok: false, message: `Wait ${wait} seconds before asking for another code.` };
  }

  const windowOpen = current && at - current.window_start < SEND_WINDOW_SECONDS;
  const sendsSoFar = windowOpen ? current.sends_in_window : 0;
  if (sendsSoFar >= MAX_SENDS_PER_WINDOW) {
    return { ok: false, message: "That's a lot of codes. Try again in an hour." };
  }

  const code = generateCode();
  const sent = await callWithCode({
    apiKey: env.TELNYX_API_KEY,
    accountSid: env.TELNYX_ACCOUNT_SID,
    applicationId: env.TELNYX_TEXML_APP_ID,
    from: env.TELNYX_PHONE_NUMBER,
    to: phone,
    code,
  });
  if (!sent.ok) {
    console.error("phone: code call failed", JSON.stringify({ detail: sent.detail }));
    return { ok: false, message: "We couldn't call that number. Check it and try again." };
  }

  await env.DB.prepare(
    `INSERT INTO phone_codes (user_id, phone_number, code_hash, expires_at, attempts, sent_at, window_start, sends_in_window)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)
     ON CONFLICT(user_id) DO UPDATE SET
       phone_number = excluded.phone_number,
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts = 0,
       sent_at = excluded.sent_at,
       window_start = excluded.window_start,
       sends_in_window = excluded.sends_in_window`,
  )
    .bind(
      userId,
      phone,
      await codeHash(env.SESSION_SECRET, userId, phone, code),
      at + CODE_TTL_SECONDS,
      at,
      windowOpen ? current.window_start : at,
      sendsSoFar + 1,
    )
    .run();

  return { ok: true };
}

/** Checks the typed code and, if it matches, links the number for good. */
export async function confirmLinkCode(env: Env, userId: string, input: string): Promise<PhoneResult> {
  const code = input.replace(/\D/g, "");
  const row = await env.DB.prepare(
    "SELECT phone_number, code_hash, expires_at, attempts FROM phone_codes WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ phone_number: string; code_hash: string; expires_at: number; attempts: number }>();

  if (!row || row.expires_at <= now()) {
    return { ok: false, message: "That code has expired. Ask for a new one." };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, message: "Too many wrong codes. Ask for a new one." };
  }

  // Count the attempt before comparing, so parallel guesses can't share one try.
  await env.DB.prepare("UPDATE phone_codes SET attempts = attempts + 1 WHERE user_id = ?").bind(userId).run();

  const expected = await codeHash(env.SESSION_SECRET, userId, row.phone_number, code);
  if (code.length !== 6 || !safeEqual(expected, row.code_hash)) {
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return {
      ok: false,
      message: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Ask for a new one.",
    };
  }

  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO phone_links (user_id, phone_number, linked_at) VALUES (?, ?, ?)").bind(
        userId,
        row.phone_number,
        new Date().toISOString(),
      ),
      env.DB.prepare("DELETE FROM phone_codes WHERE user_id = ?").bind(userId),
    ]);
  } catch (error) {
    // Either unique key: this user linked in another tab, or someone else
    // linked the number between the call and the code.
    console.error("phone: link insert failed", error);
    if (await getPhoneLink(env.DB, userId)) return { ok: true };
    return { ok: false, message: "That number is already linked to another account." };
  }

  return { ok: true };
}

/** Drops the code the user was waiting on, so they can enter a different number. */
export async function cancelLinkCode(db: D1Database, userId: string): Promise<void> {
  // The send timestamps stay, so starting over can't skip the resend wait.
  await db.prepare("UPDATE phone_codes SET expires_at = 0 WHERE user_id = ?").bind(userId).run();
}

function generateCode(): string {
  // 2^32 is not a multiple of a million; rejecting the tail keeps every code equally likely.
  const limit = 4_294_000_000;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer);
  while (buffer[0] >= limit);
  return String(buffer[0] % 1_000_000).padStart(6, "0");
}

async function codeHash(secret: string, userId: string, phone: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`phone:${userId}:${phone}:${code}`));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
