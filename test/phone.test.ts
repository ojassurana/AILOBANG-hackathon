/**
 * Tests for linking a phone and recognising a call from it.
 *
 * A real code needs a real outbound call and a real inbound call needs a real carrier, so what is
 * checked here is everything in between: which strings count as a number, how a
 * caller is read out of SIP headers, which webhooks are trusted, and what the
 * link screen offers at each step.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { calledNumber, incomingCall, verifyWebhook } from "../src/openai-webhook";
import { formatPhone, normalizePhone, phoneFromSipHeader } from "../src/phone";
import { renderPhonePage, type PhonePageOptions } from "../src/phone-page";
import { codeTexml } from "../src/telnyx";

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];

function check(name: string, run: () => void | Promise<void>) {
  pending.push(
    (async () => {
      try {
        await run();
        passed++;
        console.log(`  ok   ${name}`);
      } catch (error) {
        failed++;
        console.log(`  FAIL ${name}`);
        console.log(`       ${error instanceof Error ? error.message : String(error)}`);
      }
    })(),
  );
}

/* ------------------------------------------------------------- numbers */

check("a number with its country code is accepted however it is spaced", () => {
  assert.equal(normalizePhone("+1 (415) 555-0123"), "+14155550123");
  assert.equal(normalizePhone("+65 9123 4567"), "+6591234567");
  assert.equal(normalizePhone("0065 9123.4567"), "+6591234567");
});

check("a number without a country code is refused rather than guessed", () => {
  assert.equal(normalizePhone("415 555 0123"), null);
  assert.equal(normalizePhone("+0123456789"), null);
  assert.equal(normalizePhone("+1234"), null);
  assert.equal(normalizePhone("+1 415 555 0123 ext 9"), null);
});

check("the caller is read from the From header, with or without a plus", () => {
  assert.equal(phoneFromSipHeader('"+14155550123" <sip:+14155550123@203.0.113.9>;tag=as64'), "+14155550123");
  assert.equal(phoneFromSipHeader("<sip:14155550123@sip.telnyx.com>"), "+14155550123");
  assert.equal(phoneFromSipHeader("<sips:+6591234567@sip.telnyx.com;transport=tls>"), "+6591234567");
  assert.equal(phoneFromSipHeader("<sip:anonymous@anonymous.invalid>"), null);
});

check("North American numbers are grouped for reading, others shown as-is", () => {
  assert.equal(formatPhone("+14073580773"), "+1 407 358 0773");
  assert.equal(formatPhone("+6591234567"), "+6591234567");
});

/* ------------------------------------------------------------- webhook */

const SECRET_BYTES = new TextEncoder().encode("a test signing secret, 32 bytes!");
const SECRET = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES))}`;

async function sign(id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", SECRET_BYTES, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function webhookHeaders(id: string, timestamp: string, signature: string): Headers {
  return new Headers({ "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature });
}

const NOW = 1_790_000_000;

check("a correctly signed webhook is trusted", async () => {
  const body = '{"type":"live.transport.incoming"}';
  const signature = await sign("wh_1", String(NOW), body);
  assert.equal(await verifyWebhook(SECRET, webhookHeaders("wh_1", String(NOW), `v1,${signature}`), body, NOW), true);
});

check("any one matching signature is enough, as during a secret rotation", async () => {
  const body = "{}";
  const signature = await sign("wh_2", String(NOW), body);
  const headers = webhookHeaders("wh_2", String(NOW), `v1,bm90IGl0 v1,${signature}`);
  assert.equal(await verifyWebhook(SECRET, headers, body, NOW), true);
});

check("a changed body, a stale timestamp or a missing header is refused", async () => {
  const body = '{"a":1}';
  const signature = await sign("wh_3", String(NOW), body);
  assert.equal(
    await verifyWebhook(SECRET, webhookHeaders("wh_3", String(NOW), `v1,${signature}`), '{"a":2}', NOW),
    false,
  );
  assert.equal(
    await verifyWebhook(SECRET, webhookHeaders("wh_3", String(NOW), `v1,${signature}`), body, NOW + 3600),
    false,
  );
  assert.equal(await verifyWebhook(SECRET, new Headers(), body, NOW), false);
  assert.equal(await verifyWebhook("", webhookHeaders("wh_3", String(NOW), `v1,${signature}`), body, NOW), false);
});

const incoming = {
  object: "event",
  type: "live.transport.incoming",
  data: {
    type: "sip",
    session_id: "live_abc",
    sip_headers: [
      { name: "From", value: '"+6591234567" <sip:+6591234567@192.0.2.10>;tag=x' },
      { name: "To", value: "<sip:+14073580773@sip.api.openai.com;transport=tls>" },
      { name: "Call-ID", value: "03782086-4ce9-44bf-8b0d-4e303d2cc590" },
    ],
  },
};

check("an incoming SIP call yields its session and caller", () => {
  const call = incomingCall(incoming);
  assert.ok(call);
  assert.equal(call.sessionId, "live_abc");
  assert.equal(call.from, "+6591234567");
});

check("the older event name is still read as a call", () => {
  const call = incomingCall({ ...incoming, type: "live.call.incoming", data: { ...incoming.data, type: undefined } });
  assert.equal(call?.sessionId, "live_abc");
});

check("events that are not an incoming call are ignored", () => {
  assert.equal(incomingCall({ type: "response.completed", data: { id: "resp_1" } }), null);
  assert.equal(incomingCall({ type: "live.transport.incoming", data: { type: "webrtc", session_id: "x" } }), null);
  assert.equal(incomingCall({ type: "live.transport.incoming", data: { type: "sip" } }), null);
});

check("a call is ours only when a header other than From names our number", () => {
  const call = incomingCall(incoming)!;
  assert.equal(calledNumber(call, "+14073580773"), true);
  assert.equal(calledNumber(call, "+6560425038"), false);

  // Calling from our own number to some other line must not count as calling us.
  const reversed = incomingCall({
    ...incoming,
    data: {
      ...incoming.data,
      sip_headers: [
        { name: "From", value: "<sip:+14073580773@192.0.2.10>" },
        { name: "To", value: "<sip:proj_123@sip.api.openai.com>" },
      ],
    },
  })!;
  assert.equal(calledNumber(reversed, "+14073580773"), false);
});

/* ---------------------------------------------------------------- page */

const base: PhonePageOptions = {
  email: "caller@example.com",
  link: null,
  pending: null,
  callNumber: "+14073580773",
  welcome: false,
};

check("a fresh screen asks for a number and says the link is permanent", () => {
  const html = renderPhonePage(base);
  assert.match(html, /action="\/phone\/start"/);
  assert.match(html, /name="phone"/);
  assert.match(html, /\+1 407 358 0773/);
  assert.match(html, /permanent/);
  assert.doesNotMatch(html, /name="code"/);
});

check("straight after sign-in the way out is Skip, and the forms keep that", () => {
  const html = renderPhonePage({ ...base, welcome: true });
  assert.match(html, /href="\/phone\/skip"/);
  assert.match(html, /name="welcome" value="1"/);

  const later = renderPhonePage(base);
  assert.doesNotMatch(later, /\/phone\/skip/);
  assert.match(later, /Back to your accounts/);
});

check("a pending code asks for the code, and offers a resend and a different number", () => {
  const html = renderPhonePage({ ...base, pending: { phone: "+6591234567", expiresAt: 0 } });
  assert.match(html, /action="\/phone\/verify"/);
  assert.match(html, /autocomplete="one-time-code"/);
  assert.match(html, /formaction="\/phone\/start"[^>]*value="\+6591234567"/);
  assert.match(html, /formaction="\/phone\/restart"/);
  assert.doesNotMatch(html, /type="tel"/);
});

check("a linked number shows what to dial and offers no way to unlink", () => {
  const html = renderPhonePage({ ...base, link: { phone: "+6591234567", linkedAt: "2026-09-26T00:00:00Z" } });
  assert.match(html, /href="tel:\+14073580773"/);
  assert.match(html, /\+6591234567/);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /[Uu]nlink/);
});

check("a notice is escaped rather than trusted", () => {
  const html = renderPhonePage({ ...base, notice: '<img src=x onerror="alert(1)">' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

check("the code call reads each digit, twice", () => {
  const texml = codeTexml("482915");
  assert.match(texml, /^<\?xml version="1.0" encoding="UTF-8"\?><Response>/);
  assert.equal(texml.match(/4, 8, 2, 9, 1, 5/g)?.length, 2);
  assert.doesNotMatch(texml, /482915/);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
