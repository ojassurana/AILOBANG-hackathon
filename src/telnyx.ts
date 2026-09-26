/**
 * The one Telnyx call the Worker makes: phoning someone to read out a code.
 *
 * The code is spoken rather than texted because US carriers block texts from
 * numbers without 10DLC registration, and calls need none. The TeXML is sent
 * inline, so Telnyx never has to call back into the Worker.
 *
 * Inbound calls never touch this file. Telnyx sends them over SIP straight to
 * OpenAI, and the Worker only hears about them through OpenAI's webhook.
 */

const TEXML_CALLS_URL = "https://api.telnyx.com/v2/texml/Accounts";

export type CallResult = { ok: true } | { ok: false; detail: string };

export interface CodeCall {
  apiKey: string;
  accountSid: string;
  applicationId: string;
  from: string;
  to: string;
  code: string;
}

export async function callWithCode(call: CodeCall): Promise<CallResult> {
  let response: Response;
  try {
    response = await fetch(`${TEXML_CALLS_URL}/${encodeURIComponent(call.accountSid)}/Calls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${call.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ApplicationSid: call.applicationId,
        From: call.from,
        To: call.to,
        Timeout: 30,
        TimeLimit: 60,
        Texml: codeTexml(call.code),
      }),
    });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // Telnyx can answer 200 with an `errors` list, e.g. for a number it can't dial.
  const body = await response.text();
  let first: { code?: string; title?: string | null; detail?: string } | undefined;
  try {
    first = (JSON.parse(body) as { errors?: (typeof first)[] }).errors?.[0];
  } catch {
    if (!response.ok) return { ok: false, detail: `${response.status} ${body.slice(0, 200)}` };
  }
  if (response.ok && !first) return { ok: true };
  return {
    ok: false,
    detail: `${response.status} ${first?.code ?? ""} ${first?.detail ?? first?.title ?? ""}`.trim(),
  };
}

/** Reads the code digit by digit, twice, so it can be written down. */
export function codeTexml(code: string): string {
  const digits = code.split("").join(", ");
  const say = `<Say voice="alice">Your code is: ${digits}.</Say>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Pause length="1"/><Say voice="alice">Hello, this is Ailobang.</Say>` +
    `${say}<Pause length="1"/><Say voice="alice">Again,</Say>${say}` +
    `<Say voice="alice">Enter it on the site. Goodbye.</Say></Response>`
  );
}
