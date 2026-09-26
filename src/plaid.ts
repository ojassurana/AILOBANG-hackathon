/**
 * Plaid: the caller's own bank accounts, linked with Plaid Link.
 *
 * Not a Composio toolkit. Composio's only Plaid entry is Plaid's developer
 * dashboard, which reads a Plaid team's analytics rather than anyone's bank, so
 * this is Plaid's own integration: the Worker holds the app's Plaid keys, the
 * user picks their bank inside Plaid Link and signs in there, and Plaid hands
 * back an access token for that login (an "Item"). Users need no Plaid account.
 *
 * The access token is the whole of the grant, so it never leaves the Worker and
 * is stored encrypted. Everything here is read-only: the products requested are
 * transactions (which brings accounts and balances with it), and nothing that
 * moves money.
 */

import type { Env } from "./env";

export type PlaidEnvironment = "sandbox" | "production";

const HOSTS: Record<PlaidEnvironment, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

/**
 * Where Plaid Link offers banks from. Every code here has to be enabled for the
 * client in the Plaid Dashboard, or creating a link token fails outright.
 */
const COUNTRY_CODES = ["US"];
/** The longest history Plaid will fetch, and what Link asks the user to share. */
const DAYS_REQUESTED = 730;
/** /transactions/get's own page cap. */
const PAGE_SIZE = 500;
/** Per bank and per request: more than a spoken answer or a total ever needs. */
const MAX_TRANSACTIONS = 1500;

/** Error codes that mean the bank wants the user to sign in again through Link. */
const LOGIN_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "ITEM_LOCKED",
  "USER_SETUP_REQUIRED",
  "ACCESS_NOT_GRANTED",
  "INSUFFICIENT_CREDENTIALS",
]);
/** Error codes that mean the Item is already gone at Plaid. */
const GONE_CODES = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
  tokenKey: string;
}

/** The Plaid settings, or null when the keys have not been set on the Worker. */
export function plaidConfig(env: Env): PlaidConfig | null {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !env.PLAID_TOKEN_KEY) return null;
  return {
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    // Typed as whatever wrangler.jsonc says today, which is not all it can be.
    environment: (env.PLAID_ENV as string) === "production" ? "production" : "sandbox",
    tokenKey: env.PLAID_TOKEN_KEY,
  };
}

export class PlaidApiError extends Error {
  constructor(
    readonly code: string,
    readonly type: string,
    /** Plaid's own sentence for the end user, when it sends one. */
    readonly displayMessage: string | null,
    message: string,
  ) {
    super(message);
  }

  get needsLogin(): boolean {
    return LOGIN_CODES.has(this.code);
  }
}

async function plaidPost<T>(config: PlaidConfig, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${HOSTS[config.environment]}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = String(data.error_code ?? `HTTP_${response.status}`);
    throw new PlaidApiError(
      code,
      String(data.error_type ?? "API_ERROR"),
      typeof data.display_message === "string" ? data.display_message : null,
      `plaid ${path} failed: ${code} ${String(data.error_message ?? "")}`.trim(),
    );
  }
  return data as T;
}

/* ------------------------------------------------------------ link tokens */

/**
 * A Link token for this user. With an access token it opens Link in update mode,
 * which signs an existing bank back in rather than adding a new one.
 */
export async function createLinkToken(
  config: PlaidConfig,
  userId: string,
  updateAccessToken?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    client_name: "Ailobang",
    language: "en",
    country_codes: COUNTRY_CODES,
    user: { client_user_id: userId },
  };
  if (updateAccessToken) {
    body.access_token = updateAccessToken;
  } else {
    body.products = ["transactions"];
    body.transactions = { days_requested: DAYS_REQUESTED };
  }
  const data = await plaidPost<{ link_token: string }>(config, "/link/token/create", body);
  return data.link_token;
}

/* ---------------------------------------------------------------- storage */

export interface LinkedAccount {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
}

/** A linked bank as stored, without its access token. */
export interface PlaidBank {
  itemId: string;
  institutionId: string | null;
  institutionName: string;
  accounts: LinkedAccount[];
  needsLogin: boolean;
  linkedAt: string;
}

interface ItemRow {
  item_id: string;
  access_token: string;
  institution_id: string | null;
  institution_name: string;
  accounts: string;
  needs_login: number;
  linked_at: string;
}

function toBank(row: ItemRow): PlaidBank {
  let accounts: LinkedAccount[] = [];
  try {
    accounts = JSON.parse(row.accounts) as LinkedAccount[];
  } catch {
    // A row whose account list will not parse still names its bank.
  }
  return {
    itemId: row.item_id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    accounts,
    needsLogin: row.needs_login === 1,
    linkedAt: row.linked_at,
  };
}

async function itemRows(db: D1Database, userId: string): Promise<ItemRow[]> {
  const result = await db
    .prepare(
      `SELECT item_id, access_token, institution_id, institution_name, accounts, needs_login, linked_at
       FROM plaid_items WHERE user_id = ? ORDER BY linked_at`,
    )
    .bind(userId)
    .all<ItemRow>();
  return result.results ?? [];
}

export async function listBanks(db: D1Database, userId: string): Promise<PlaidBank[]> {
  return (await itemRows(db, userId)).map(toBank);
}

async function itemRow(db: D1Database, userId: string, itemId: string): Promise<ItemRow | null> {
  return db
    .prepare(
      `SELECT item_id, access_token, institution_id, institution_name, accounts, needs_login, linked_at
       FROM plaid_items WHERE user_id = ? AND item_id = ?`,
    )
    .bind(userId, itemId)
    .first<ItemRow>();
}

export async function findBank(db: D1Database, userId: string, itemId: string): Promise<PlaidBank | null> {
  const row = await itemRow(db, userId, itemId);
  return row ? toBank(row) : null;
}

async function setNeedsLogin(db: D1Database, userId: string, itemId: string, needsLogin: boolean): Promise<void> {
  await db
    .prepare("UPDATE plaid_items SET needs_login = ? WHERE user_id = ? AND item_id = ?")
    .bind(needsLogin ? 1 : 0, userId, itemId)
    .run();
}

/* --------------------------------------------------------- link and unlink */

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: {
    available: number | null;
    current: number | null;
    limit: number | null;
    iso_currency_code: string | null;
    unofficial_currency_code?: string | null;
  };
}

interface AccountsResponse {
  accounts: PlaidAccount[];
  item: { item_id: string; institution_id?: string | null; institution_name?: string | null };
}

function linkedAccount(account: PlaidAccount): LinkedAccount {
  return {
    id: account.account_id,
    name: account.name,
    mask: account.mask ?? null,
    type: account.type,
    subtype: account.subtype ?? null,
  };
}

/**
 * Turns the public token Link returned into a stored bank.
 *
 * Linking a bank that is already linked replaces the old login rather than
 * keeping two: two Items for one bank would double every balance and every
 * transaction the agent adds up.
 */
export async function linkBank(
  config: PlaidConfig,
  db: D1Database,
  userId: string,
  publicToken: string,
): Promise<PlaidBank> {
  const exchanged = await plaidPost<{ access_token: string; item_id: string }>(
    config,
    "/item/public_token/exchange",
    { public_token: publicToken },
  );
  const { access_token: accessToken, item_id: itemId } = exchanged;

  const details = await plaidPost<AccountsResponse>(config, "/accounts/get", { access_token: accessToken });
  const institutionId = details.item.institution_id ?? null;
  const institutionName =
    details.item.institution_name ?? (await institutionNameFor(config, institutionId)) ?? "Your bank";

  if (institutionId) {
    for (const row of await itemRows(db, userId)) {
      if (row.institution_id === institutionId && row.item_id !== itemId) {
        await removeRow(config, db, userId, row).catch((error) =>
          console.error("replacing an older plaid item failed", error),
        );
      }
    }
  }

  const bank: PlaidBank = {
    itemId,
    institutionId,
    institutionName,
    accounts: details.accounts.map(linkedAccount),
    needsLogin: false,
    linkedAt: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO plaid_items
         (item_id, user_id, access_token, institution_id, institution_name, accounts, needs_login, linked_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         access_token = excluded.access_token,
         institution_name = excluded.institution_name,
         accounts = excluded.accounts,
         needs_login = 0`,
    )
    .bind(
      itemId,
      userId,
      await sealToken(config.tokenKey, accessToken, itemId, userId),
      institutionId,
      institutionName,
      JSON.stringify(bank.accounts),
      bank.linkedAt,
    )
    .run();
  return bank;
}

async function institutionNameFor(config: PlaidConfig, institutionId: string | null): Promise<string | null> {
  if (!institutionId) return null;
  try {
    const data = await plaidPost<{ institution: { name: string } }>(config, "/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: COUNTRY_CODES,
    });
    return data.institution.name;
  } catch (error) {
    console.error("plaid institution lookup failed", error);
    return null;
  }
}

/** A Link token that signs one of this user's banks back in. */
export async function updateLinkToken(
  config: PlaidConfig,
  db: D1Database,
  userId: string,
  itemId: string,
): Promise<string | null> {
  const row = await itemRow(db, userId, itemId);
  if (!row) return null;
  const accessToken = await openToken(config.tokenKey, row.access_token, row.item_id, userId);
  return createLinkToken(config, userId, accessToken);
}

/** Update mode finished: the same Item works again, so only the flag changes. */
export async function markSignedIn(db: D1Database, userId: string, itemId: string): Promise<PlaidBank | null> {
  await setNeedsLogin(db, userId, itemId, false);
  return findBank(db, userId, itemId);
}

/**
 * Revokes the Item at Plaid, then forgets it here.
 *
 * The local row goes only once Plaid has let go of the Item (or says it never
 * had it): dropping the token first would leave a live grant nobody can revoke.
 */
async function removeRow(config: PlaidConfig, db: D1Database, userId: string, row: ItemRow): Promise<void> {
  try {
    const accessToken = await openToken(config.tokenKey, row.access_token, row.item_id, userId);
    await plaidPost(config, "/item/remove", { access_token: accessToken });
  } catch (error) {
    if (!(error instanceof PlaidApiError && GONE_CODES.has(error.code))) throw error;
  }
  await db.prepare("DELETE FROM plaid_items WHERE user_id = ? AND item_id = ?").bind(userId, row.item_id).run();
}

export async function removeBank(
  config: PlaidConfig,
  db: D1Database,
  userId: string,
  itemId: string,
): Promise<PlaidBank | null> {
  const row = await itemRow(db, userId, itemId);
  if (!row) return null;
  await removeRow(config, db, userId, row);
  return toBank(row);
}

export async function removeAllBanks(config: PlaidConfig, db: D1Database, userId: string): Promise<number> {
  const rows = await itemRows(db, userId);
  for (const row of rows) await removeRow(config, db, userId, row);
  return rows.length;
}

/* ------------------------------------------------------- what the agent reads */

export interface AccountBalance {
  bank: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  current: number | null;
  available: number | null;
  limit: number | null;
  currency: string | null;
}

export interface BankTransaction {
  bank: string;
  account: string;
  accountMask: string | null;
  date: string;
  name: string;
  merchant: string | null;
  /** Plaid's sign: positive is money leaving the account, negative is money in. */
  amount: number;
  currency: string | null;
  category: string | null;
  pending: boolean;
}

/** One bank's answer: what it returned, or the reason it returned nothing. */
export interface BankResult<T> {
  bank: string;
  items: T[];
  problem: string | null;
}

/** The part of Plaid the agent's tools use. */
export interface PlaidActions {
  banks(): Promise<PlaidBank[]>;
  balances(): Promise<BankResult<AccountBalance>[]>;
  transactions(startDate: string, endDate: string): Promise<BankResult<BankTransaction>[]>;
}

/** One user's linked banks, as the agent's tools see them. */
export class PlaidBanks implements PlaidActions {
  constructor(
    private readonly config: PlaidConfig,
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  async banks(): Promise<PlaidBank[]> {
    return listBanks(this.db, this.userId);
  }

  async balances(): Promise<BankResult<AccountBalance>[]> {
    return this.eachBank(async (row, accessToken) => {
      // Live balances where the bank offers them; the balance Plaid last fetched
      // is still a real answer where it does not.
      let data: AccountsResponse;
      try {
        data = await plaidPost<AccountsResponse>(this.config, "/accounts/balance/get", { access_token: accessToken });
      } catch (error) {
        if (error instanceof PlaidApiError && error.needsLogin) throw error;
        data = await plaidPost<AccountsResponse>(this.config, "/accounts/get", { access_token: accessToken });
      }
      return data.accounts.map((account) => ({
        bank: row.institution_name,
        name: account.official_name || account.name,
        mask: account.mask ?? null,
        type: account.type,
        subtype: account.subtype ?? null,
        current: account.balances.current,
        available: account.balances.available,
        limit: account.balances.limit,
        currency: account.balances.iso_currency_code ?? account.balances.unofficial_currency_code ?? null,
      }));
    });
  }

  async transactions(startDate: string, endDate: string): Promise<BankResult<BankTransaction>[]> {
    return this.eachBank(async (row, accessToken) => {
      const found: BankTransaction[] = [];
      let accounts = new Map<string, PlaidAccount>();
      let total = Infinity;

      while (found.length < total && found.length < MAX_TRANSACTIONS) {
        const page = await plaidPost<{
          accounts: PlaidAccount[];
          transactions: PlaidTransaction[];
          total_transactions: number;
        }>(this.config, "/transactions/get", {
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: PAGE_SIZE, offset: found.length },
        });
        if (!accounts.size) accounts = new Map(page.accounts.map((account) => [account.account_id, account]));
        total = page.total_transactions;
        if (!page.transactions.length) break;

        for (const transaction of page.transactions) {
          const account = accounts.get(transaction.account_id);
          found.push({
            bank: row.institution_name,
            account: account ? account.name : "an account",
            accountMask: account?.mask ?? null,
            date: transaction.date,
            name: transaction.name,
            merchant: transaction.merchant_name ?? null,
            amount: transaction.amount,
            currency: transaction.iso_currency_code ?? transaction.unofficial_currency_code ?? null,
            category: categoryOf(transaction),
            pending: transaction.pending,
          });
        }
      }
      return found;
    });
  }

  /**
   * Runs one read against every linked bank, so that one bank needing a new
   * sign-in reports itself instead of hiding the others' answers.
   */
  private async eachBank<T>(read: (row: ItemRow, accessToken: string) => Promise<T[]>): Promise<BankResult<T>[]> {
    const rows = await itemRows(this.db, this.userId);
    return Promise.all(
      rows.map(async (row) => {
        try {
          const accessToken = await openToken(this.config.tokenKey, row.access_token, row.item_id, this.userId);
          const items = await read(row, accessToken);
          if (row.needs_login === 1) await setNeedsLogin(this.db, this.userId, row.item_id, false);
          return { bank: row.institution_name, items, problem: null };
        } catch (error) {
          console.error("plaid read failed", row.institution_name, error);
          if (error instanceof PlaidApiError && error.needsLogin) {
            await setNeedsLogin(this.db, this.userId, row.item_id, true).catch(() => {});
          }
          return { bank: row.institution_name, items: [], problem: problemSentence(row.institution_name, error) };
        }
      }),
    );
  }
}

interface PlaidTransaction {
  account_id: string;
  date: string;
  name: string;
  merchant_name?: string | null;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  pending: boolean;
  personal_finance_category?: { primary: string; detailed: string } | null;
  category?: string[] | null;
}

/** Plaid's category in words: FOOD_AND_DRINK reads as "food and drink". */
function categoryOf(transaction: PlaidTransaction): string | null {
  const primary = transaction.personal_finance_category?.primary;
  if (primary) return primary.toLowerCase().replace(/_/g, " ");
  return transaction.category?.length ? transaction.category.join(" / ").toLowerCase() : null;
}

/** Why one bank returned nothing, said so the agent can pass it on as is. */
export function problemSentence(bank: string, error: unknown): string {
  if (!(error instanceof PlaidApiError)) return `${bank} could not be read just now.`;
  if (error.needsLogin) {
    return `${bank} needs the caller to sign in again. They can do it from the Plaid row on their accounts page.`;
  }
  switch (error.code) {
    case "PRODUCT_NOT_READY":
      return `${bank} was linked moments ago and Plaid is still fetching its transactions. Try again in a minute or two.`;
    case "INSTITUTION_DOWN":
    case "INSTITUTION_NOT_RESPONDING":
    case "INSTITUTION_NOT_AVAILABLE":
      return `${bank} isn't responding to Plaid right now. Try again later.`;
    case "RATE_LIMIT_EXCEEDED":
    case "ACCOUNTS_LIMIT":
    case "TRANSACTIONS_LIMIT":
      return `${bank} has been asked too often just now. Try again in a few minutes.`;
    default:
      return error.displayMessage ?? `${bank} could not be read just now.`;
  }
}

/* ------------------------------------------------------ token encryption */

async function tokenCryptoKey(secret: string): Promise<CryptoKey> {
  const raw = base64ToBytes(secret);
  if (raw.length !== 32) throw new Error("PLAID_TOKEN_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Binds the ciphertext to its row, so a token moved to another user fails to open. */
function tokenContext(itemId: string, userId: string): Uint8Array {
  return new TextEncoder().encode(`plaid:${userId}:${itemId}`);
}

export async function sealToken(secret: string, token: string, itemId: string, userId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenContext(itemId, userId) },
    await tokenCryptoKey(secret),
    new TextEncoder().encode(token),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(sealed))}`;
}

export async function openToken(secret: string, sealed: string, itemId: string, userId: string): Promise<string> {
  const [version, iv, body] = sealed.split(".");
  if (version !== "v1" || !iv || !body) throw new Error("unrecognised sealed plaid token");
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv), additionalData: tokenContext(itemId, userId) },
    await tokenCryptoKey(secret),
    base64ToBytes(body),
  );
  return new TextDecoder().decode(opened);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
