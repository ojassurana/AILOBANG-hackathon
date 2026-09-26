/**
 * Minimal Composio REST client (v3.1) for the connect flow.
 *
 * Connections are scoped to a `user_id`, which we set to the WorkOS user id so
 * every customer sees only their own connected accounts.
 */
const COMPOSIO_API = "https://backend.composio.dev/api/v3.1";

/** Account states Composio reports. We only surface the ones users can act on. */
export type AccountStatus = "ACTIVE" | "PENDING" | "FAILED" | "UNKNOWN";

export interface ConnectedAccount {
  id: string;
  status: string;
  slug: string;
  alias: string | null;
  label: string | null;
  /** The provider URL Composio suggests for checking this connection. */
  testEndpoint: string | null;
}

interface RawAccount {
  id?: string;
  status?: string;
  alias?: string | null;
  toolkit?: { slug?: string };
  state?: { val?: Record<string, unknown> };
  test_request_endpoint?: string | null;
}

async function composioFetch<T>(
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${COMPOSIO_API}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`composio ${path} -> ${response.status} ${body.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

/**
 * Some toolkits put a readable identity in the connection state (LinkedIn
 * returns displayName). Google ones do not, and Composio's own generated
 * word_id is meaningless to a user, so a missing label stays missing here and
 * gets resolved through the proxy instead.
 */
function deriveLabel(account: RawAccount): string | null {
  const val = account.state?.val ?? {};
  const candidates = [
    "displayName",
    "display_name",
    "email",
    "emailAddress",
    "username",
    "name",
    "site_name",
    "subdomain",
    "shop",
    "instanceName",
  ];

  for (const key of candidates) {
    const value = val[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return account.alias ?? null;
}

export async function listConnectedAccounts(
  apiKey: string,
  userId: string,
): Promise<Map<string, ConnectedAccount>> {
  const query = new URLSearchParams({ user_ids: userId, limit: "100" });
  const data = await composioFetch<{ items?: RawAccount[] }>(
    apiKey,
    `/connected_accounts?${query.toString()}`,
  );

  const byToolkit = new Map<string, ConnectedAccount>();
  for (const item of data.items ?? []) {
    const slug = item.toolkit?.slug;
    if (!slug) continue;

    const account: ConnectedAccount = {
      id: item.id ?? "",
      status: normaliseStatus(item.status),
      slug,
      alias: item.alias ?? null,
      label: deriveLabel(item),
      testEndpoint: item.test_request_endpoint ?? null,
    };

    // A toolkit can hold several accounts; keep the healthiest one.
    const existing = byToolkit.get(slug);
    if (!existing || (existing.status !== "ACTIVE" && account.status === "ACTIVE")) {
      byToolkit.set(slug, account);
    }
  }

  return byToolkit;
}

function normaliseStatus(status?: string): AccountStatus {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "INITIALIZING":
    case "INITIATED":
      return "PENDING";
    case "FAILED":
    case "EXPIRED":
    case "REVOKED":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

/** Creates a Composio Connect Link and returns the URL to send the user to. */
export async function createConnectLink(
  apiKey: string,
  userId: string,
  authConfigId: string,
  callbackUrl: string,
): Promise<string> {
  const data = await composioFetch<{ redirect_url?: string }>(
    apiKey,
    "/connected_accounts/link",
    {
      method: "POST",
      body: JSON.stringify({
        auth_config_id: authConfigId,
        user_id: userId,
        callback_url: callbackUrl,
      }),
    },
  );

  if (!data.redirect_url) throw new Error("composio link response had no redirect_url");
  return data.redirect_url;
}

/** Every connection this user holds for one toolkit — a user may have several. */
export async function listAccountIds(
  apiKey: string,
  userId: string,
  toolkitSlug: string,
): Promise<string[]> {
  const query = new URLSearchParams({ user_ids: userId, limit: "100" });
  const data = await composioFetch<{ items?: RawAccount[] }>(
    apiKey,
    `/connected_accounts?${query.toString()}`,
  );

  return (data.items ?? [])
    .filter((item) => item.toolkit?.slug === toolkitSlug && item.id)
    .map((item) => item.id as string);
}

/** Removes a connected account from Composio. */
export async function deleteConnectedAccount(apiKey: string, accountId: string): Promise<void> {
  await composioFetch<unknown>(apiKey, `/connected_accounts/${accountId}`, { method: "DELETE" });
}

/* ------------------------------------------------------ account identity */

const IDENTITY_KEYS = [
  "emailaddress",
  "email",
  "mail",
  "login",
  "username",
  "user_name",
  "screen_name",
  "handle",
  "displayname",
  "display_name",
  "real_name",
  "name",
  "team",
  "workspace",
  "subdomain",
  "shop",
  "instancename",
  "account",
];

const REJECTED_KEY =
  /link|url|photo|avatar|icon|image|scope|token|secret|verifier|etag|kind|_id$|^id$|type|state|expir/i;

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function walkIdentity(
  value: unknown,
  key: string,
  depth: number,
  found: { emails: string[]; named: string[] },
): void {
  if (depth > 5 || value === null || value === undefined) return;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > 120) return;
    if (/^https?:\/\//i.test(text)) return;
    if (REJECTED_KEY.test(key)) return;

    if (isEmail(text)) found.emails.push(text);
    else if (IDENTITY_KEYS.includes(key.toLowerCase())) found.named.push(text);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) walkIdentity(item, key, depth + 1, found);
    return;
  }

  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      walkIdentity(child, childKey, depth + 1, found);
    }
  }
}

/** Picks the most human-readable identifier out of a provider response. */
export function pickIdentity(payload: unknown): string | null {
  const found = { emails: [] as string[], named: [] as string[] };
  walkIdentity(payload, "", 0, found);
  return found.emails[0] ?? found.named[0] ?? null;
}

/**
 * The list endpoint omits `test_request_endpoint`; only the per-account detail
 * call returns it, so it has to be fetched separately before a probe.
 */
export async function fetchTestEndpoint(apiKey: string, accountId: string): Promise<string | null> {
  const data = await composioFetch<{ test_request_endpoint?: string | null }>(
    apiKey,
    `/connected_accounts/${accountId}`,
  );
  return data.test_request_endpoint ?? null;
}

/**
 * Asks the provider who a connection belongs to, through Composio's proxy —
 * the only way to learn the owning account for toolkits that return no profile
 * (Google's toolkits hand back tokens and scopes, nothing else).
 */
export async function resolveAccountIdentity(
  apiKey: string,
  accountId: string,
  endpoint: string,
): Promise<string | null> {
  const data = await composioFetch<{ data?: unknown }>(apiKey, "/tools/execute/proxy", {
    method: "POST",
    body: JSON.stringify({ connected_account_id: accountId, endpoint, method: "GET" }),
  });

  return pickIdentity(data?.data);
}
