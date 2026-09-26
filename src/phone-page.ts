/**
 * The phone screen: link a number with a code read out in a call so the owner can call in.
 *
 * Optional, and offered once right after sign-in. Like the Telegram screen it is
 * plain forms with no script, and the step shown comes from what is stored — a
 * pending code or a finished link — rather than from the URL.
 */

import { formatPhone, type PendingCode, type PhoneLink } from "./phone";

export interface PhonePageOptions {
  email: string;
  link: PhoneLink | null;
  pending: PendingCode | null;
  /** The number people call, in E.164. */
  callNumber: string;
  /** Shown straight after sign-in, where leaving means skipping rather than going back. */
  welcome: boolean;
  notice?: string | null;
  /** A notice that reports success rather than a problem. */
  noticeTone?: "bad" | "ok";
}

export function renderPhonePage(options: PhonePageOptions): string {
  const { email, link, welcome } = options;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Call from your phone · Ailobang</title>
    <link rel="icon" href="/favicon.svg" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #fbfbfd;
        --fg: #16161a;
        --muted: #6b6b76;
        --card: #ffffff;
        --accent: #16161a;
        --accent-fg: #ffffff;
        --border: rgba(0, 0, 0, 0.10);
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.05);
        --ok: #1a9b52;
        --wait: #c9861a;
        --bad: #c0392b;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0d0d10;
          --fg: #f4f4f6;
          --muted: #9a9aa5;
          --card: #141418;
          --accent: #f4f4f6;
          --accent-fg: #16161a;
          --border: rgba(255, 255, 255, 0.12);
          --shadow: none;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .shell { max-width: 560px; margin: 0 auto; padding: 40px 20px 64px; }
      .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
      .sub { margin: 0; color: var(--muted); font-size: 14px; }
      .who { color: var(--muted); font-size: 13px; text-align: right; white-space: nowrap; }
      .who a { color: inherit; }
      .card {
        margin-top: 32px;
        padding: 24px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
      }
      .step { display: flex; align-items: center; gap: 10px; margin: 0 0 4px; font-size: 18px; }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 9px;
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        color: var(--muted);
      }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
      .dot.ok { background: var(--ok); }
      .dot.wait { background: var(--wait); }
      .dot.bad { background: var(--bad); }
      .lede { margin: 10px 0 0; color: var(--muted); font-size: 14px; }
      .lede strong { color: var(--fg); }
      .number { display: block; margin: 14px 0 0; font-size: 24px; font-weight: 650; letter-spacing: 0.01em; }
      .number a { color: inherit; text-decoration: none; }
      .note { margin: 18px 0 0; padding: 11px 13px; border-radius: 11px; font-size: 13.5px; }
      .note.ok { background: rgba(26, 155, 82, 0.10); border: 1px solid rgba(26, 155, 82, 0.26); }
      .note.bad { background: rgba(192, 57, 43, 0.10); border: 1px solid rgba(192, 57, 43, 0.26); }
      label { display: block; margin: 20px 0 6px; font-size: 13.5px; font-weight: 600; }
      input {
        width: 100%;
        padding: 11px 13px;
        font: inherit;
        font-size: 16px;
        color: var(--fg);
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 11px;
      }
      input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
      .hint { margin: 8px 0 0; color: var(--muted); font-size: 12.5px; }
      .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
      .btn {
        display: inline-block;
        padding: 10px 15px;
        border: 0;
        border-radius: 10px;
        background: var(--accent);
        color: var(--accent-fg);
        font: inherit;
        font-size: 14px;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
      }
      .btn.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
      button.link, a.link {
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        font-size: 13.5px;
        color: var(--muted);
        text-decoration: underline;
        cursor: pointer;
      }
      .back { margin-top: 22px; font-size: 13.5px; }
      .back a { color: var(--muted); }
      @media (max-width: 560px) {
        .who { display: none; }
        .shell { padding: 28px 14px 48px; }
        .card { padding: 18px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div>
          <h1>${link ? "Your phone is linked" : "Call from your phone"}</h1>
          <p class="sub">${
            link ? "Call Ailobang from it any time." : "Optional. You can always call from this site instead."
          }</p>
        </div>
        <div class="who">${escapeHtml(email)}<br /><a href="/auth/logout">Log out</a></div>
      </div>
      <div class="card">
${renderStep(options)}
      </div>
      ${
        link || !welcome
          ? `<p class="back"><a href="/app">Back to your accounts</a></p>`
          : `<p class="back"><a href="/phone/skip">Skip for now</a></p>`
      }
    </div>
  </body>
</html>`;
}

function renderStep({ link, pending, callNumber, welcome, notice, noticeTone }: PhonePageOptions): string {
  const note = notice ? `<p class="note ${noticeTone ?? "bad"}">${escapeHtml(notice)}</p>` : "";
  const number = formatPhone(callNumber);
  const keepWelcome = welcome ? `<input type="hidden" name="welcome" value="1" />` : "";

  if (link) {
    return `
        <p class="step"><span class="pill"><span class="dot ok"></span>Linked</span></p>
        ${note}
        <p class="lede">From <strong>${escapeHtml(formatPhone(link.phone))}</strong>, call</p>
        <span class="number"><a href="tel:${escapeHtml(callNumber)}">${escapeHtml(number)}</a></span>
        <p class="lede">It's the same assistant as a call on the site, with the same connected accounts.
        Calls from any other number won't be answered.</p>
        <p class="hint">A linked number is permanent and can't be removed or changed.</p>
        <div class="actions">
          <a class="btn" href="/app">Done</a>
          <a class="btn ghost" href="/call">Call from the site</a>
        </div>`;
  }

  if (pending) {
    return `
        <p class="step"><span class="pill"><span class="dot wait"></span>Step 2 of 2</span></p>
        <p class="lede">We're calling <strong>${escapeHtml(formatPhone(pending.phone))}</strong>
        from ${escapeHtml(number)}. Pick up and we'll read you a 6-digit code.</p>
        ${note}
        <form method="post" action="/phone/verify">
          ${keepWelcome}
          <label for="code">Code from the call</label>
          <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"
                 pattern="[0-9 ]*" autofocus required />
          <p class="hint">Once you confirm, this number is linked for good. It can't be removed or changed later.</p>
          <div class="actions">
            <button class="btn" type="submit">Link this number</button>
            <button class="link" type="submit" formaction="/phone/start" formnovalidate
                    name="phone" value="${escapeHtml(pending.phone)}">Call me again</button>
            <button class="link" type="submit" formaction="/phone/restart" formnovalidate>Use a different number</button>
          </div>
        </form>`;
  }

  return `
        <p class="step"><span class="pill"><span class="dot${notice && noticeTone !== "ok" ? " bad" : ""}"></span>Step 1 of 2</span></p>
        <p class="lede">Link your phone number and you can call Ailobang at
        <strong>${escapeHtml(number)}</strong>, not just from this site. We'll call you with a code to
        confirm it's yours.</p>
        ${note}
        <form method="post" action="/phone/start">
          ${keepWelcome}
          <label for="phone">Your phone number</label>
          <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel"
                 placeholder="+1 415 555 0123" required />
          <p class="hint">Include the country code. A linked number is permanent and can't be removed or changed.</p>
          <div class="actions">
            <button class="btn" type="submit">Call me with a code</button>
          </div>
        </form>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
