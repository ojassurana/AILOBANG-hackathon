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
  wordId: string | null;
  label: string | null;
}

interface RawAccount {
  id?: string;
  status?: string;
  alias?: string | null;
  word_id?: string | null;
  toolkit?: { slug?: string };
  state?: { val?: Record<string, unknown> };
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
 * Every OAuth2 toolkit we expose hands back a token but no profile, so the
 * connected account's own fields are the only identity we can show. Prefer
 * whatever humans recognise, and fall back to Composio's generated word id.
 */
function deriveLabel(account: RawAccount): string | null {
  const val = account.state?.val ?? {};
  const candidates = [
    "displayName",
    "display_name",
    "account_id",
    "account_url",
    "site_name",
    "subdomain",
    "shop",
    "instanceName",
    "username",
    "name",
    "email",
  ];

  for (const key of candidates) {
    const value = val[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const authedUser = val.authed_user;
  if (authedUser && typeof authedUser === "object") {
    const id = (authedUser as Record<string, unknown>).user_id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }

  return account.alias ?? account.word_id ?? null;
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
      wordId: item.word_id ?? null,
      label: deriveLabel(item),
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
