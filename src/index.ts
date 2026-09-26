/**
 * Ailobang — Cloudflare Worker serving a landing page, a sign-in page, and the
 * post-login "Connect your accounts" page, with WorkOS AuthKit as the identity
 * provider, Composio for third-party connections, and D1 as the user store.
 *
 * The AuthKit Authorization Code flow is implemented against the WorkOS REST API
 * with PKCE, so the Worker holds no client secret (only the public client id).
 */

import {
  CONNECTORS,
  connectorBySlug,
  logoUrl,
  type Connector,
} from "./connectors";
import {
  createConnectLink,
  listConnectedAccounts,
  type ConnectedAccount,
} from "./composio";

const WORKOS_API = "https://api.workos.com";
const SESSION_COOKIE = "alb_session";
const PKCE_COOKIE = "alb_pkce";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const PKCE_TTL_SECONDS = 60 * 10;

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKOS_CLIENT_ID: string;
  WORKOS_REDIRECT_URI: string;
  SESSION_SECRET: string;
  COMPOSIO_API_KEY: string;
}

interface WorkOSUser {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
  email_verified?: boolean;
}

interface WorkOSAuthenticateResponse {
  user: WorkOSUser;
  organization_id?: string | null;
  access_token?: string;
}

interface Session {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
  sid: string | null;
  exp: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("unhandled error", error);
      return errorPage(500, "Something went wrong", "Please try again in a moment.");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  // Composio sends the browser back here after a connection attempt, so this
  // has to be matched before the /connect/<toolkit> route below.
  if (path === "/connect/return" || path.startsWith("/connect/return/")) {
    return finishConnect(request, env, path);
  }
  if (path.startsWith("/connect/")) {
    return startConnect(request, env, path.slice("/connect/".length));
  }

  switch (path) {
    case "/":
      return serveAsset(request, env, "/index.html");
    case "/signin":
      if (await currentSession(request, env)) return redirect("/app", request);
      return serveAsset(request, env, "/signin.html");
    case "/auth/login":
      return startLogin(env);
    case "/callback":
      return finishLogin(request, env);
    case "/app":
      return appPage(request, env);
    case "/auth/logout":
      return logout(request, env);
    case "/favicon.svg":
    case "/favicon.ico":
      return serveAsset(request, env, "/favicon.svg");
    default:
      return errorPage(404, "Not found", "That page does not exist.");
  }
}

function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  return env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: request.headers }));
}

function redirect(path: string, request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: new URL(path, request.url).toString(), "Cache-Control": "no-store" },
  });
}

/* ------------------------------------------------------------------ login */

async function startLogin(env: Env): Promise<Response> {
  const state = randomToken(16);
  const verifier = randomToken(32);

  const authorize = new URL(`${WORKOS_API}/user_management/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.WORKOS_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", env.WORKOS_REDIRECT_URI);
  authorize.searchParams.set("provider", "authkit");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", await sha256(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": cookie(PKCE_COOKIE, `${state}.${verifier}`, PKCE_TTL_SECONDS),
      "Cache-Control": "no-store",
    },
  });
}

async function finishLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clearPkce = cookie(PKCE_COOKIE, "", 0);

  const denied = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (denied) {
    return errorPage(400, "Sign-in failed", denied, { headers: { "Set-Cookie": clearPkce } });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const [savedState, verifier] = (readCookie(request, PKCE_COOKIE) ?? "").split(".");
  if (!code || !verifier || !savedState || !safeEqual(state, savedState)) {
    return errorPage(
      400,
      "Sign-in failed",
      "This sign-in attempt expired or could not be verified. Please start again.",
      { headers: { "Set-Cookie": clearPkce } },
    );
  }

  const response = await fetch(`${WORKOS_API}/user_management/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      ip_address: request.headers.get("CF-Connecting-IP") ?? undefined,
      user_agent: request.headers.get("User-Agent") ?? undefined,
    }),
  });

  if (!response.ok) {
    console.error("workos authenticate failed", response.status, await response.text());
    const rejected = response.status >= 400 && response.status < 500;
    return errorPage(
      rejected ? 400 : 502,
      "Sign-in failed",
      rejected
        ? "This sign-in attempt expired or was already used. Please try again."
        : "We could not complete the sign-in. Please try again in a moment.",
      { headers: { "Set-Cookie": clearPkce } },
    );
  }

  const payload = (await response.json()) as WorkOSAuthenticateResponse;
  const user = payload.user;
  await upsertUser(env.DB, user, payload.organization_id ?? null);

  const claims = decodeJwtClaims(payload.access_token);
  const session: Session = {
    sub: user.id,
    email: user.email,
    name: fullName(user),
    picture: user.profile_picture_url ?? null,
    sid: typeof claims?.sid === "string" ? claims.sid : null,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };

  const headers = new Headers({
    Location: new URL("/app", url).toString(),
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", clearPkce);
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, await sealSession(env, session), SESSION_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));

  if (session?.sid) {
    const url = new URL(`${WORKOS_API}/user_management/sessions/logout`);
    url.searchParams.set("session_id", session.sid);
    url.searchParams.set("return_to", new URL("/", request.url).toString());
    headers.set("Location", url.toString());
  } else {
    headers.set("Location", new URL("/", request.url).toString());
  }

  return new Response(null, { status: 302, headers });
}

/* ------------------------------------------------------------- pages + db */

async function appPage(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return redirect("/signin", request);

  const url = new URL(request.url);
  const justConnected = url.searchParams.get("connected");
  const denied = url.searchParams.get("error");

  let accounts = new Map<string, ConnectedAccount>();
  let warning: string | null = null;
  try {
    accounts = await listConnectedAccounts(env.COMPOSIO_API_KEY, session.sub);
  } catch (error) {
    console.error("composio listConnectedAccounts failed", error);
    warning = "We couldn't reach the connector service. Refresh to try again.";
  }

  const html = renderConnectionsPage(session, accounts, { justConnected, denied, warning });
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Sends the user into Composio's hosted Connect Link for one toolkit. */
async function startConnect(request: Request, env: Env, slug: string): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return redirect("/signin", request);

  const connector = connectorBySlug(slug);
  if (!connector) {
    return errorPage(404, "Unknown connector", "That connector isn't available.", {
      back: { href: "/app", label: "Back to your accounts" },
    });
  }

  const callbackUrl = new URL(`/connect/return/${connector.slug}`, request.url).toString();

  try {
    const link = await createConnectLink(
      env.COMPOSIO_API_KEY,
      session.sub,
      connector.authConfigId,
      callbackUrl,
    );
    return new Response(null, {
      status: 302,
      headers: { Location: link, "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("composio createConnectLink failed", error);
    return errorPage(
      502,
      "Couldn't start that connection",
      `We couldn't open the ${connector.name} sign-in. Please try again.`,
      { back: { href: "/app", label: "Back to your accounts" } },
    );
  }
}

/** Composio redirects here after the user finishes (or abandons) a connection. */
async function finishConnect(request: Request, env: Env, path: string): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return redirect("/signin", request);

  const url = new URL(request.url);
  const slug = path.replace("/connect/return", "").replace(/^\//, "");
  const target = new URL("/app", url);

  if (slug) target.searchParams.set("connected", slug);
  const denied = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (denied) target.searchParams.set("error", denied);

  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), "Cache-Control": "no-store" },
  });
}

function renderConnectionsPage(
  session: Session,
  accounts: Map<string, ConnectedAccount>,
  flash: { justConnected: string | null; denied: string | null; warning: string | null },
): string {
  const connected = CONNECTORS.filter((c) => accounts.get(c.slug)?.status === "ACTIVE").length;

  let banner = "";
  if (flash.denied) {
    banner = `<p class="note bad">That connection didn't finish (${escapeHtml(flash.denied)}). You can try again below.</p>`;
  } else if (flash.justConnected) {
    const name = connectorBySlug(flash.justConnected)?.name ?? "Account";
    banner = `<p class="note ok">${escapeHtml(name)} connected.</p>`;
  } else if (flash.warning) {
    banner = `<p class="note bad">${escapeHtml(flash.warning)}</p>`;
  }

  const rows = CONNECTORS.map((connector) =>
    connectorRow(connector, accounts.get(connector.slug)),
  ).join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect your accounts · Ailobang</title>
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
      .shell { max-width: 860px; margin: 0 auto; padding: 48px 20px 72px; }
      .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.02em; }
      .sub { margin: 0; color: var(--muted); font-size: 14px; }
      .who { color: var(--muted); font-size: 13px; text-align: right; white-space: nowrap; }
      .who a { color: inherit; }
      .note { margin: 24px 0 0; padding: 12px 14px; border-radius: 12px; font-size: 14px; }
      .note.ok { background: rgba(26, 155, 82, 0.10); border: 1px solid rgba(26, 155, 82, 0.26); }
      .note.bad { background: rgba(192, 57, 43, 0.10); border: 1px solid rgba(192, 57, 43, 0.26); }
      .card {
        margin-top: 28px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        overflow: hidden;
        box-shadow: var(--shadow);
      }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 14px 18px; border-top: 1px solid var(--border); vertical-align: middle; }
      tr:first-child td { border-top: 0; }
      .app { display: flex; align-items: center; gap: 12px; }
      .app img { border-radius: 8px; flex: none; }
      .nm { display: block; font-weight: 550; }
      .bl { display: block; color: var(--muted); font-size: 12.5px; }
      .pill { display: inline-flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 550; }
      .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
      .dot.ok { background: #1a9b52; }
      .dot.wait { background: #c9861a; }
      .dot.bad { background: #c0392b; }
      .acct { display: block; margin-top: 2px; color: var(--muted); font-size: 12.5px; }
      .muted { color: var(--muted); font-size: 13.5px; }
      .act { text-align: right; width: 1%; white-space: nowrap; }
      .btn {
        display: inline-block;
        padding: 8px 14px;
        border-radius: 9px;
        background: var(--accent);
        color: var(--accent-fg);
        font-size: 13.5px;
        font-weight: 550;
        text-decoration: none;
      }
      .btn:hover { opacity: 0.88; }
      .btn.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
      @media (max-width: 560px) {
        .bl, .who { display: none; }
        .shell { padding: 32px 14px 56px; }
        td { padding: 12px 14px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div>
          <h1>Connect your accounts</h1>
          <p class="sub">${connected} of ${CONNECTORS.length} connected. You can change these any time.</p>
        </div>
        <div class="who">${escapeHtml(session.email)}<br /><a href="/auth/logout">Log out</a></div>
      </div>
${banner}
      <div class="card">
        <table>
${rows}
        </table>
      </div>
    </div>
  </body>
</html>`;
}

function connectorRow(connector: Connector, account: ConnectedAccount | undefined): string {
  const status = account?.status ?? null;

  let state: string;
  if (status === "ACTIVE") {
    state = `<span class="pill"><span class="dot ok"></span>Connected</span>${
      account?.label ? `<span class="acct">${escapeHtml(account.label)}</span>` : ""
    }`;
  } else if (status === "PENDING") {
    state = `<span class="pill"><span class="dot wait"></span>Finishing sign-in</span>`;
  } else if (status === "FAILED") {
    state = `<span class="pill"><span class="dot bad"></span>Failed</span>`;
  } else {
    state = `<span class="muted">Not connected</span>`;
  }

  const action =
    status === "ACTIVE"
      ? `<a class="btn ghost" href="/connect/${connector.slug}">Reconnect</a>`
      : `<a class="btn" href="/connect/${connector.slug}">Connect now</a>`;

  return `          <tr>
            <td>
              <span class="app">
                <img src="${logoUrl(connector.slug)}" alt="" width="28" height="28" loading="lazy" />
                <span>
                  <span class="nm">${escapeHtml(connector.name)}</span>
                  <span class="bl">${escapeHtml(connector.blurb)}</span>
                </span>
              </span>
            </td>
            <td>${state}</td>
            <td class="act">${action}</td>
          </tr>`;
}

async function upsertUser(db: D1Database, user: WorkOSUser, organizationId: string | null): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (
         id, email, first_name, last_name, profile_picture_url,
         email_verified, organization_id, sign_in_count, created_at, updated_at, last_sign_in_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8, ?8)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         profile_picture_url = excluded.profile_picture_url,
         email_verified = excluded.email_verified,
         organization_id = excluded.organization_id,
         sign_in_count = users.sign_in_count + 1,
         updated_at = excluded.updated_at,
         last_sign_in_at = excluded.last_sign_in_at`,
    )
    .bind(
      user.id,
      user.email,
      user.first_name ?? null,
      user.last_name ?? null,
      user.profile_picture_url ?? null,
      user.email_verified ? 1 : 0,
      organizationId,
      now,
    )
    .run();
}

/* ------------------------------------------------------------- sessions */

async function currentSession(request: Request, env: Env): Promise<Session | null> {
  return openSession(env, readCookie(request, SESSION_COOKIE));
}

async function sealSession(env: Env, session: Session): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(session)));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

async function openSession(env: Env, raw: string | null): Promise<Session | null> {
  if (!raw) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return null;
  if (!safeEqual(signature, await hmac(env.SESSION_SECRET, payload))) return null;

  try {
    const session = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Session;
    if (!session.sub || session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

function decodeJwtClaims(token?: string): Record<string, unknown> | null {
  const encoded = token?.split(".")[1];
  if (!encoded) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(encoded))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- helpers */

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function fullName(user: WorkOSUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
}

function randomToken(bytes: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(value: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64urlEncode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorPage(
  status: number,
  title: string,
  detail: string,
  options: { headers?: Record<string, string>; back?: { href: string; label: string } } = {},
): Response {
  const { headers: extraHeaders = {}, back = { href: "/signin", label: "Back to log in" } } = options;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        background: Canvas;
        color: CanvasText;
        font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      main { max-width: 420px; padding: 24px; text-align: center; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { margin: 0 0 24px; opacity: 0.65; font-size: 14px; }
      a { color: inherit; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
      <a href="${back.href}">${escapeHtml(back.label)}</a>
    </main>
  </body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}
