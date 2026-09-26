/**
 * Ailobang — Cloudflare Worker serving a landing page, a sign-in page, and a
 * post-login page, with WorkOS AuthKit as the identity provider and D1 as the
 * user store.
 *
 * The AuthKit Authorization Code flow is implemented against the WorkOS REST API
 * with PKCE, so the Worker holds no client secret (only the public client id).
 */

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
    return errorPage(400, "Sign-in failed", denied, { "Set-Cookie": clearPkce });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const [savedState, verifier] = (readCookie(request, PKCE_COOKIE) ?? "").split(".");
  if (!code || !verifier || !savedState || !safeEqual(state, savedState)) {
    return errorPage(
      400,
      "Sign-in failed",
      "This sign-in attempt expired or could not be verified. Please start again.",
      { "Set-Cookie": clearPkce },
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
      { "Set-Cookie": clearPkce },
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

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello World</title>
    <link rel="icon" href="/favicon.svg" />
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
      main { text-align: center; padding: 24px; }
      h1 { margin: 0 0 12px; font-size: 44px; letter-spacing: -0.03em; }
      p { margin: 0; opacity: 0.6; font-size: 14px; }
      a { color: inherit; }
    </style>
  </head>
  <body>
    <main>
      <h1>Hello World</h1>
      <p>${escapeHtml(session.email)} &middot; <a href="/auth/logout">Log out</a></p>
    </main>
  </body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
  });
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
  extraHeaders: Record<string, string> = {},
): Response {
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
      <a href="/signin">Back to log in</a>
    </main>
  </body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}
