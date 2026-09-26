/**
 * OpenAI's incoming-call webhook: signature check and the fields a call needs.
 *
 * OpenAI signs webhooks the Standard Webhooks way: an HMAC-SHA256, keyed by the
 * endpoint's `whsec_` secret, over `${webhook-id}.${webhook-timestamp}.${body}`,
 * sent as one or more space-separated `v1,<base64>` entries.
 */

import { phoneFromSipHeader } from "./phone";

/** Older deliveries than this are refused, so a captured request can't be replayed. */
const TOLERANCE_SECONDS = 5 * 60;

export interface IncomingCall {
  /** The `live_...` id every accept, reject, attach and hangup takes. */
  sessionId: string;
  /** The caller's number, from the SIP `From` header. */
  from: string | null;
  headers: { name: string; value: string }[];
}

export async function verifyWebhook(
  secret: string,
  headers: Headers,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !secret) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(nowSeconds - sentAt) > TOLERANCE_SECONDS) return false;

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64Decode(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = base64Encode(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))),
  );

  return signatures
    .split(" ")
    .map((entry) => entry.split(","))
    .some(([version, signature]) => version === "v1" && signature !== undefined && safeEqual(signature, expected));
}

/**
 * The call in a `live.transport.incoming` event, or null for any other event.
 *
 * `live.call.incoming` is the name older subscriptions still deliver; it
 * carries the same data without `data.type`.
 */
export function incomingCall(event: unknown): IncomingCall | null {
  if (!event || typeof event !== "object") return null;
  const { type, data } = event as { type?: string; data?: Record<string, unknown> };
  if (type !== "live.transport.incoming" && type !== "live.call.incoming") return null;
  if (!data || (data.type !== undefined && data.type !== "sip")) return null;

  const sessionId = typeof data.session_id === "string" ? data.session_id : null;
  if (!sessionId) return null;

  const headers = Array.isArray(data.sip_headers)
    ? (data.sip_headers as unknown[]).filter(
        (header): header is { name: string; value: string } =>
          !!header &&
          typeof (header as { name?: unknown }).name === "string" &&
          typeof (header as { value?: unknown }).value === "string",
      )
    : [];

  const fromHeader = headers.find((header) => header.name.toLowerCase() === "from");
  return { sessionId, from: fromHeader ? phoneFromSipHeader(fromHeader.value) : null, headers };
}

/**
 * Whether the call was made to `number`.
 *
 * The OpenAI project may take calls for other numbers too, so a call is only
 * ours when some header still names the dialled number. Digits are compared so
 * a missing `+` doesn't matter.
 */
export function calledNumber(call: IncomingCall, number: string): boolean {
  const digits = number.replace(/\D/g, "");
  if (!digits) return false;
  return call.headers.some(
    (header) => header.name.toLowerCase() !== "from" && header.value.replace(/\D/g, "").includes(digits),
  );
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
