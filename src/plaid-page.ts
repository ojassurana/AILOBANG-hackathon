/**
 * The Plaid screen: the banks this user linked, and the button that links more.
 *
 * Linking happens inside Plaid Link, Plaid's own window: the user searches for
 * their bank, signs in there (a bank like Chase opens its own sign-in in a
 * pop-up), and chooses which accounts to share. The page never sees a bank
 * password. What comes back is a one-time public token, which the page posts to
 * the Worker to exchange; the access token it turns into never reaches the page.
 *
 * The same button in update mode signs a bank back in when Plaid says its login
 * has lapsed, which keeps the Item — and its history — rather than adding a
 * second one.
 */

import { callWidget } from "./call-widget";
import type { PlaidBank, PlaidEnvironment } from "./plaid";

export interface PlaidPageOptions {
  email: string;
  /** Whose calls the live-call widget follows. */
  userId: string;
  /** Null when the site has no Plaid keys yet. */
  environment: PlaidEnvironment | null;
  banks: PlaidBank[];
  notice?: { tone: "ok" | "bad" | "info"; text: string } | null;
}

export function renderPlaidPage({ email, userId, environment, banks, notice }: PlaidPageOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect your bank · Ailobang</title>
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
      .dot.bad { background: var(--bad); }
      .lede { margin: 10px 0 0; color: var(--muted); font-size: 14px; }
      .note { margin: 18px 0 0; padding: 11px 13px; border-radius: 11px; font-size: 13.5px; }
      .note.ok { background: rgba(26, 155, 82, 0.10); border: 1px solid rgba(26, 155, 82, 0.26); }
      .note.bad { background: rgba(192, 57, 43, 0.10); border: 1px solid rgba(192, 57, 43, 0.26); }
      .note.info { background: rgba(127, 127, 127, 0.10); border: 1px solid var(--border); }
      .note:empty { display: none; }
      .banks { list-style: none; margin: 18px 0 0; padding: 0; }
      .bank { padding: 14px 0; border-top: 1px solid var(--border); }
      .bank:first-child { border-top: 0; padding-top: 0; }
      .bank-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
      .bank-name { font-weight: 600; }
      .accts { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
      .bank-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
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
      .btn[disabled] { opacity: 0.6; cursor: default; }
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
      .hint { margin: 14px 0 0; color: var(--muted); font-size: 12.5px; }
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
          <h1>Connect your bank</h1>
          <p class="sub">Balances and transactions through Plaid. Read-only: nothing can move money.</p>
        </div>
        <div class="who">${escapeHtml(email)}<br /><a href="/auth/logout">Log out</a></div>
      </div>
      <div class="card">
${environment ? renderBanks(banks, environment, notice ?? null) : renderUnavailable()}
      </div>
      <p class="back"><a href="/app">Back to your accounts</a></p>
    </div>
${environment ? linkScript() : ""}
${callWidget(userId)}
  </body>
</html>`;
}

function renderUnavailable(): string {
  return `
        <p><span class="pill"><span class="dot"></span>Not available yet</span></p>
        <p class="lede">Bank linking isn't switched on for Ailobang yet. Check back soon.</p>`;
}

function renderBanks(
  banks: PlaidBank[],
  environment: PlaidEnvironment,
  notice: PlaidPageOptions["notice"] | null,
): string {
  const list = banks.length
    ? `<ul class="banks">${banks.map(renderBank).join("")}
        </ul>`
    : `<p class="lede">Pick your bank — Chase, Bank of America, Wells Fargo, Amex, Capital One and
        thousands more — and sign in to it inside Plaid's window. Ailobang never sees your bank
        password, and you don't need a Plaid account.</p>`;

  const sandbox =
    environment === "sandbox"
      ? `<p class="hint">Test mode: only Plaid's test banks work. Sign in with username
        <strong>user_good</strong> and password <strong>pass_good</strong>.</p>`
      : "";

  return `
        <p><span class="pill"><span class="dot${banks.length ? (banks.some((b) => b.needsLogin) ? " bad" : " ok") : ""}"></span>${
          banks.length ? `${banks.length} bank${banks.length === 1 ? "" : "s"} linked` : "No bank linked"
        }</span></p>
        ${list}
        <p class="note${notice ? ` ${notice.tone}` : ""}" id="plaid-status" role="status" aria-live="polite">${
          notice ? escapeHtml(notice.text) : ""
        }</p>
        <div class="actions">
          <button class="btn" type="button" data-plaid-link>${banks.length ? "Link another bank" : "Link a bank"}</button>
          ${banks.length ? `<a class="btn ghost" href="/app">Done</a>` : ""}
        </div>
        ${sandbox}`;
}

function renderBank(bank: PlaidBank): string {
  const accounts = bank.accounts.length
    ? bank.accounts.map((account) => `${account.name}${account.mask ? ` ••${account.mask}` : ""}`).join(", ")
    : "No accounts shared";
  const state = bank.needsLogin
    ? `<span class="pill"><span class="dot bad"></span>Needs sign-in</span>`
    : `<span class="pill"><span class="dot ok"></span>Connected</span>`;
  const fix = bank.needsLogin
    ? `<button class="btn" type="button" data-plaid-link data-item="${escapeHtml(bank.itemId)}">Sign in again</button>`
    : "";
  const confirmText = `Remove ${bank.institutionName}? The agent will stop seeing its balances and transactions.`;

  return `
          <li class="bank">
            <div class="bank-head">
              <span class="bank-name">${escapeHtml(bank.institutionName)}</span>
              ${state}
            </div>
            <p class="accts">${escapeHtml(accounts)}</p>
            <div class="bank-actions">
              ${fix}
              <form class="inline" method="post" action="/plaid/remove"
                    onsubmit="return confirm(${escapeHtml(JSON.stringify(confirmText))})">
                <input type="hidden" name="item_id" value="${escapeHtml(bank.itemId)}" />
                <button class="link" type="submit">Remove</button>
              </form>
            </div>
          </li>`;
}

/**
 * Opens Plaid Link. The link token is fetched only on click: it expires after
 * a few hours, and an update-mode token belongs to one bank.
 */
function linkScript(): string {
  return `    <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
    <script>
      (function () {
        var status = document.getElementById("plaid-status");
        function say(text, tone) {
          status.textContent = text || "";
          status.className = "note" + (text ? " " + (tone || "info") : "");
        }
        async function post(path, body) {
          var res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
          });
          var data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
          return data;
        }
        async function open(button) {
          var itemId = button.getAttribute("data-item");
          button.disabled = true;
          say("Opening Plaid…");
          try {
            if (!window.Plaid) throw new Error("Plaid didn't load. Check your connection and refresh.");
            var token = (await post("/plaid/link-token", itemId ? { itemId: itemId } : {})).linkToken;
            window.Plaid.create({
              token: token,
              onSuccess: async function (publicToken) {
                say("Saving your bank…");
                try {
                  var saved = itemId
                    ? await post("/plaid/signed-in", { itemId: itemId })
                    : await post("/plaid/exchange", { publicToken: publicToken });
                  location.href = "/plaid?" + (itemId ? "fixed=" : "linked=") + encodeURIComponent(saved.itemId);
                } catch (error) {
                  say(error.message, "bad");
                  button.disabled = false;
                }
              },
              onExit: function (error) {
                button.disabled = false;
                say(error ? error.display_message || error.error_message || "Plaid closed before finishing." : "",
                    error ? "bad" : "info");
              },
            }).open();
            say("");
          } catch (error) {
            say(error.message, "bad");
            button.disabled = false;
          }
        }
        document.querySelectorAll("[data-plaid-link]").forEach(function (button) {
          button.addEventListener("click", function () { open(button); });
        });
      })();
    </script>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
