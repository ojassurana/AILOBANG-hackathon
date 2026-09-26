/**
 * The two pages that read call history back: the list, and one conversation.
 *
 * Both are server-rendered from what the agent wrote during the call, so they
 * say nothing a call did not actually do. Times are rendered in words, which is
 * the same in every time zone; a small script adds the caller's own clock to
 * each one, and the page is still correct without it.
 */

import { callWidget } from "./call-widget";
import {
  absoluteWhen,
  formatDuration,
  groupByDay,
  whenPhrase,
  type ChatLine,
  type ChatSummary,
} from "./chats";

export interface HistoryPageOptions {
  email: string;
  userId: string;
  chats: ChatSummary[];
  now: Date;
}

export interface ChatPageOptions {
  email: string;
  userId: string;
  chat: ChatSummary;
  lines: ChatLine[];
  now: Date;
}

const THEME = `      :root {
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
      .shell { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; }
      .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      .back { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px;
        text-decoration: none; margin-bottom: 14px; }
      .back:hover { color: var(--fg); }
      h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; overflow-wrap: anywhere; }
      .sub { margin: 0; color: var(--muted); font-size: 14px; }
      .who { color: var(--muted); font-size: 13px; text-align: right; white-space: nowrap; }
      .who a { color: inherit; }
      .card {
        margin-top: 28px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .empty { padding: 28px 24px; }
      .empty p { margin: 0; color: var(--muted); font-size: 14px; }
      h2.group { margin: 28px 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em;
        text-transform: uppercase; color: var(--muted); }
      h2.group:first-of-type { margin-top: 24px; }
      ul.calls { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
      ul.calls a {
        display: block;
        padding: 14px 16px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        box-shadow: var(--shadow);
        color: inherit;
        text-decoration: none;
      }
      ul.calls a:hover { border-color: rgba(127, 127, 127, 0.45); }
      .calltitle { display: block; font-weight: 600; overflow-wrap: anywhere; }
      .callmeta { display: block; margin-top: 3px; color: var(--muted); font-size: 13px; }
      .pill {
        display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px;
        border: 1px solid var(--border); border-radius: 999px; font-size: 12px; font-weight: 600;
        color: var(--muted);
      }
      .head { padding: 22px 24px 18px; border-bottom: 1px solid var(--border); }
      .head h1 { font-size: 20px; margin: 12px 0 0; }
      .facts { margin: 8px 0 0; color: var(--muted); font-size: 13.5px; }
      .go {
        display: inline-flex; align-items: center; gap: 9px; margin-top: 16px;
        padding: 12px 18px; border-radius: 12px;
        background: var(--accent); color: var(--accent-fg);
        font-size: 15px; font-weight: 600; text-decoration: none;
      }
      .go svg { width: 18px; height: 18px; }
      .lines { padding: 8px 24px 20px; }
      .line { display: grid; grid-template-columns: 74px 1fr; gap: 14px; padding: 14px 0; }
      .line + .line { border-top: 1px solid var(--border); }
      .line .who-said { color: var(--muted); font-size: 12.5px; font-weight: 600; padding-top: 2px; }
      .line .said { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .line.user .said { font-weight: 500; }
      @media (max-width: 560px) {
        .shell { padding: 28px 14px 56px; }
        .who { display: none; }
        .line { grid-template-columns: 1fr; gap: 4px; }
        .lines { padding: 4px 16px 16px; }
        .head { padding: 20px 16px 16px; }
      }`;

/**
 * Puts the caller's own clock on each timestamp.
 *
 * The words in the markup are timezone-free; this is what turns them into the
 * wall clock the caller reads, in the browser's zone rather than the server's.
 */
const LOCAL_TIME_SCRIPT = `    <script>
      (function () {
        var nodes = document.querySelectorAll("time[datetime]");
        for (var i = 0; i < nodes.length; i++) {
          var at = new Date(nodes[i].getAttribute("datetime"));
          if (isNaN(at.getTime())) continue;
          nodes[i].title = at.toLocaleString();
          if (!nodes[i].hasAttribute("data-local")) continue;
          nodes[i].textContent = at.toLocaleString([], {
            day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
          });
        }
      })();
    </script>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A stamp whose visible text is a phrase, and whose title is the exact instant. */
function stamp(at: string, now: Date, text?: string): string {
  return `<time datetime="${escapeHtml(at)}"${text === undefined ? "" : ' data-local="1"'}>${escapeHtml(
    text ?? whenPhrase(at, now),
  )}</time>`;
}

/** Where a call came from, in the words the list uses for it. */
function channelLabel(channel: ChatSummary["channel"]): string {
  return channel === "phone" ? "Dialled in" : "From the site";
}

/** The second line under a title: when it ran, how long, and how it got here. */
function callFacts(chat: ChatSummary, now: Date): string {
  const parts = [`Started ${stamp(chat.startedAt, now)}`];
  const duration = formatDuration(chat.seconds);
  if (duration) parts.push(duration);
  if (chat.channel === "phone") parts.push(channelLabel(chat.channel));
  return parts.join(" · ");
}

const MIC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
            <path d="M19 11a7 7 0 0 1-14 0" />
            <path d="M12 18v3" />
          </svg>`;

export function renderHistoryPage({ email, userId, chats, now }: HistoryPageOptions): string {
  const body = chats.length
    ? groupByDay(chats, now)
        .map(
          (group) => `      <h2 class="group">${escapeHtml(group.label)}</h2>
      <ul class="calls">
${group.chats
  .map(
    (chat) => `        <li>
          <a href="/chat/${encodeURIComponent(chat.id)}">
            <span class="calltitle">${escapeHtml(chat.title)}</span>
            <span class="callmeta">${callFacts(chat, now)}</span>
          </a>
        </li>`,
  )
  .join("\n")}
      </ul>`,
        )
        .join("\n")
    : `      <div class="card empty">
        <p>No calls yet. Start one and it will be here afterwards, with everything you said.</p>
      </div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your calls · Ailobang</title>
    <link rel="icon" href="/favicon.svg" />
    <style>
${THEME}
    </style>
  </head>
  <body>
    <div class="shell">
      <a class="back" href="/app">&#8592; Your accounts</a>
      <div class="top">
        <div>
          <h1>Your calls</h1>
          <p class="sub">Everything you have asked Ailobang, newest first.</p>
        </div>
        <div class="who">${escapeHtml(email)}<br /><a href="/auth/logout">Log out</a></div>
      </div>
${body}
    </div>
${LOCAL_TIME_SCRIPT}
${callWidget(userId)}
  </body>
</html>`;
}

export function renderChatPage({ email, userId, chat, lines, now }: ChatPageOptions): string {
  const duration = formatDuration(chat.seconds);
  const spoken = lines.length
    ? lines
        .map(
          (line) => `        <div class="line ${line.role}">
          <span class="who-said">${line.role === "user" ? "You" : "Ailobang"}</span>
          <p class="said">${escapeHtml(line.text.trim())}</p>
        </div>`,
        )
        .join("\n")
    : `        <div class="line"><span class="who-said"></span><p class="said">Nothing was said on this call.</p></div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(chat.title)} · Ailobang</title>
    <link rel="icon" href="/favicon.svg" />
    <style>
${THEME}
    </style>
  </head>
  <body>
    <div class="shell">
      <a class="back" href="/history">&#8592; Your calls</a>
      <div class="top">
        <div></div>
        <div class="who">${escapeHtml(email)}<br /><a href="/auth/logout">Log out</a></div>
      </div>
      <div class="card">
        <div class="head">
          <span class="pill">${escapeHtml(channelLabel(chat.channel))}</span>
          <h1>${escapeHtml(chat.title)}</h1>
          <p class="facts">Started ${stamp(chat.startedAt, now, absoluteWhen(chat.startedAt))}${
            duration ? ` · ${escapeHtml(duration)}` : ""
          }</p>
          <a class="go" href="/call?chat=${encodeURIComponent(chat.id)}">${MIC_ICON} Resume this call</a>
        </div>
        <div class="lines">
${spoken}
        </div>
      </div>
    </div>
${LOCAL_TIME_SCRIPT}
${callWidget(userId)}
  </body>
</html>`;
}
