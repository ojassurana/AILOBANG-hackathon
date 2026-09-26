/**
 * The one Telnyx call the Worker makes: sending a text from the site's number.
 *
 * Inbound calls never touch this file. Telnyx sends them over SIP straight to
 * OpenAI, and the Worker only hears about them through OpenAI's webhook.
 */

const TELNYX_MESSAGES_URL = "https://api.telnyx.com/v2/messages";

export type SmsResult = { ok: true } | { ok: false; detail: string };

export async function sendSms(apiKey: string, from: string, to: string, text: string): Promise<SmsResult> {
  let response: Response;
  try {
    response = await fetch(TELNYX_MESSAGES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, text }),
    });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  if (response.ok) return { ok: true };

  // Telnyx explains a refused send in `errors[].detail`, e.g. a destination the
  // messaging profile does not allow.
  const body = await response.text();
  let detail = `${response.status}`;
  try {
    const parsed = JSON.parse(body) as { errors?: { code?: string; title?: string; detail?: string }[] };
    const first = parsed.errors?.[0];
    if (first) detail = `${response.status} ${first.code ?? ""} ${first.detail ?? first.title ?? ""}`.trim();
  } catch {
    detail = `${response.status} ${body.slice(0, 200)}`;
  }
  return { ok: false, detail };
}
