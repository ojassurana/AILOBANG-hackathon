/**
 * The Telegram login screen: one step at a time, phone then code then password.
 *
 * This is a user session for the caller's real Telegram account, so the screen
 * has one job — get to "connected" without inviting more codes than necessary.
 * The step shown comes from the stored login state rather than from the URL, so
 * a refresh, a back button, or a second tab all land on the step that is
 * actually pending.
 *
 * Plain forms, no script: every step is a POST that redirects back here, and the
 * browser's own `required` and `autocomplete` do the input work.
 */

import type { TelegramStatus } from "./telegram";

export interface TelegramPageOptions {
  email: string;
  status: TelegramStatus;
  /** A sentence to show in place of whatever the login recorded. */
  notice?: string | null;
}

export function renderTelegramPage({ email, status, notice }: TelegramPageOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect Telegram · Ailobang</title>
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
      .note { margin: 18px 0 0; padding: 11px 13px; border-radius: 11px; font-size: 13.5px; }
      .note.ok { background: rgba(26, 155, 82, 0.10); border: 1px solid rgba(26, 155, 82, 0.26); }
      .note.bad { background: rgba(192, 57, 43, 0.10); border: 1px solid rgba(192, 57, 43, 0.26); }
      .note.wait { background: rgba(201, 134, 26, 0.10); border: 1px solid rgba(201, 134, 26, 0.26); }
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
      form.inline { display: inline; }
      button.link {
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
          <h1>Connect Telegram</h1>
          <p class="sub">${escapeHtml(statusSubtitle(status))}</p>
        </div>
        <div class="who">${escapeHtml(email)}<br /><a href="/auth/logout">Log out</a></div>
      </div>
      <div class="card">
${renderStep(status, notice ?? null)}
      </div>
      <p class="back"><a href="/app">Back to your accounts</a></p>
    </div>
  </body>
</html>`;
}

function statusSubtitle(status: TelegramStatus): string {
  return status.phase === "connected"
    ? "Connected. The agent can send and read your messages."
    : "Sign in with your own account, not a bot.";
}

function renderStep(status: TelegramStatus, notice: string | null): string {
  const error = notice ?? status.error;

  switch (status.phase) {
    case "code":
      return `
        <p class="step"><span class="pill"><span class="dot wait"></span>Step 2 of 2</span></p>
        <p class="lede">${escapeHtml(
          status.codeViaApp
            ? "Telegram sent the code to your Telegram app, not by SMS. Open Telegram and look for the message from Telegram."
            : "Telegram sent a code by SMS to " + (status.phone ?? "your number") + ".",
        )}</p>
        ${errorNote(error, "wait")}
        <form method="post" action="/telegram/code">
          <label for="code">Code from Telegram</label>
          <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"
                 autofocus required />
          <div class="actions">
            <button class="btn" type="submit">Finish connecting</button>
            <button class="link" type="submit" formaction="/telegram/restart" formnovalidate>
              Send a new code
            </button>
          </div>
        </form>`;

    case "password":
      return `
        <p class="step"><span class="pill"><span class="dot wait"></span>Two-step password</span></p>
        <p class="lede">This account has a two-step password, which Telegram asks for after the code.</p>
        ${errorNote(error, "wait")}
        <form method="post" action="/telegram/password">
          <label for="password">Your Telegram password</label>
          <input id="password" name="password" type="password" autocomplete="current-password"
                 autofocus required />
          <p class="hint">This is the password you chose in Telegram, not your phone's unlock code.</p>
          <div class="actions">
            <button class="btn" type="submit">Finish connecting</button>
          </div>
        </form>`;

    case "connected":
      return `
        <p class="step"><span class="pill"><span class="dot ok"></span>Connected</span></p>
        <p class="lede">Signed in as ${
          status.username ? `<strong>@${escapeHtml(status.username)}</strong>` : ""
        }${
          status.username && status.phone ? " on " : ""
        }${status.phone ? escapeHtml(status.phone) : ""}.</p>
        <p class="lede">Ask the agent to send a message to someone by their @username, or to read
        what has come in. Nothing from before you connected is read, and every send is read back to
        you for a yes first.</p>
        <div class="actions">
          <form class="inline" method="post" action="/disconnect/telegram"
                onsubmit="return confirm('Disconnect Telegram? The agent will stop being able to send and read your messages.')">
            <button class="link" type="submit">Disconnect</button>
          </form>
          <a class="btn" href="/app">Done</a>
        </div>`;

    default:
      return `
        <p class="step"><span class="pill"><span class="dot${error ? " bad" : ""}"></span>${
          error ? "Needs attention" : "Step 1 of 2"
        }</span></p>
        <p class="lede">Enter the phone number on the Telegram account you want the agent to use.
        Telegram will send you a code to sign in.</p>
        ${errorNote(error, "bad")}
        <form method="post" action="/telegram/start">
          <label for="phone">Phone number</label>
          <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel"
                 placeholder="+65 9123 4567" value="${escapeHtml(status.phone ?? "")}" required />
          <p class="hint">Include the country code. Use the number Telegram already knows you by.</p>
          <div class="actions">
            <button class="btn" type="submit">Send me a code</button>
          </div>
        </form>`;
  }
}

/**
 * The stored error, which is a sentence and already carries the wait when there
 * is one — a flood's message says how long to leave it, so `retryAt` needs no
 * line of its own.
 */
function errorNote(error: string | null, tone: "bad" | "wait"): string {
  return error ? `<p class="note ${tone}">${escapeHtml(error)}</p>` : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
