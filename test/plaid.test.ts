/**
 * Tests for the Plaid bank connector.
 *
 * What is load-bearing here is what the agent gets told. The totals it reads
 * aloud must be the real sums of what matched, not of the rows it was shown; a
 * bank that failed must say so rather than quietly shrinking a total; and a
 * stored access token must not open for anyone but the user it was sealed for.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { plaidRowState } from "../src/connector-state";
import { CONNECTORS, isComposio } from "../src/connectors";
import {
  PlaidApiError,
  openToken,
  problemSentence,
  sealToken,
  type AccountBalance,
  type BankResult,
  type BankTransaction,
  type PlaidActions,
  type PlaidBank,
} from "../src/plaid";
import { PlaidToolbox, dateRange, isPlaidTool, plaidTools } from "../src/plaid-tools";

let passed = 0;
let failed = 0;

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

const NOW = new Date("2026-09-26T12:00:00Z");

const chase: PlaidBank = {
  itemId: "item-chase",
  institutionId: "ins_56",
  institutionName: "Chase",
  accounts: [{ id: "acc-1", name: "Checking", mask: "1234", type: "depository", subtype: "checking" }],
  needsLogin: false,
  linkedAt: "2026-09-01T00:00:00Z",
};

function transaction(overrides: Partial<BankTransaction>): BankTransaction {
  return {
    bank: "Chase",
    account: "Checking",
    accountMask: "1234",
    date: "2026-09-20",
    name: "STARBUCKS #123",
    merchant: "Starbucks",
    amount: 5.4,
    currency: "USD",
    category: "food and drink",
    pending: false,
    ...overrides,
  };
}

class FakePlaid implements PlaidActions {
  asked: Array<[string, string]> = [];
  constructor(
    private readonly linked: PlaidBank[],
    private readonly rows: BankResult<BankTransaction>[] = [],
    private readonly balanceRows: BankResult<AccountBalance>[] = [],
  ) {}
  async banks() {
    return this.linked;
  }
  async balances() {
    return this.balanceRows;
  }
  async transactions(start: string, end: string) {
    this.asked.push([start, end]);
    return this.rows;
  }
}

const toolbox = (plaid: PlaidActions | null) => new PlaidToolbox(plaid, () => NOW);

/* ---------------------------------------------------------------- the row */

await check("the Plaid row is not a Composio row and carries no auth config", () => {
  const row = CONNECTORS.find((connector) => connector.slug === "plaid");
  assert.ok(row, "there is a plaid row");
  assert.equal(row.kind, "plaid");
  assert.equal(isComposio(row), false);
  assert.equal(row.authConfigId, undefined);
});

await check("no banks reads as not connected", () => {
  const state = plaidRowState([]);
  assert.equal(state.tone, null);
  assert.equal(state.actionKind, "connect");
  assert.equal(state.canDisconnect, false);
});

await check("linked banks are named, and the list shortens past two", () => {
  const state = plaidRowState([
    { institutionName: "Chase", needsLogin: false },
    { institutionName: "Amex", needsLogin: false },
    { institutionName: "Citi", needsLogin: false },
  ]);
  assert.equal(state.tone, "ok");
  assert.equal(state.accountLabel, "Chase, Amex +1");
  assert.equal(state.actionLabel, "Manage");
  assert.equal(state.canDisconnect, true);
});

await check("one bank needing sign-in turns the row red with a fix", () => {
  const state = plaidRowState([
    { institutionName: "Chase", needsLogin: false },
    { institutionName: "Amex", needsLogin: true },
  ]);
  assert.equal(state.tone, "bad");
  assert.equal(state.label, "Needs sign-in");
  assert.equal(state.actionKind, "resume");
});

/* -------------------------------------------------------------- the tools */

await check("both tools are recognised and neither offers to move money", () => {
  const tools = plaidTools(NOW);
  assert.deepEqual(tools.map((tool) => tool.function.name), ["plaid_list_accounts", "plaid_transactions"]);
  for (const tool of tools) assert.ok(isPlaidTool(tool.function.name));
  assert.ok(tools[1].function.description.includes("2026-09-26"), "the schema carries today's date");
});

await check("without Plaid keys the tools say so rather than reporting no banks", async () => {
  const output = await toolbox(null).run("plaid_list_accounts", "{}");
  assert.match(output, /isn't set up/);
});

await check("with nothing linked the tools send the caller to the Plaid row", async () => {
  const output = await toolbox(new FakePlaid([])).run("plaid_transactions", "{}");
  assert.match(output, /hasn't linked a bank/);
  assert.match(output, /Plaid row/);
});

await check("totals cover every match, not just the rows shown", async () => {
  const rows = Array.from({ length: 40 }, (_, index) =>
    transaction({ date: `2026-09-${String((index % 25) + 1).padStart(2, "0")}`, amount: 2.5 }),
  );
  const plaid = new FakePlaid([chase], [{ bank: "Chase", items: rows, problem: null }]);
  const output = await toolbox(plaid).run("plaid_transactions", JSON.stringify({ search: "starbucks", limit: 5 }));
  assert.match(output, /40 found/);
  assert.match(output, /Total spent: 100\.00 USD/);
  assert.match(output, /showing 5 of 40/);
});

await check("direction and search filter, and money in is reported as received", async () => {
  const rows = [
    transaction({ name: "PAYROLL", merchant: null, amount: -2000, category: "income" }),
    transaction({ amount: 5.4 }),
    transaction({ name: "UBER TRIP", merchant: "Uber", amount: 18, category: "transportation" }),
  ];
  const plaid = new FakePlaid([chase], [{ bank: "Chase", items: rows, problem: null }]);
  const received = await toolbox(plaid).run("plaid_transactions", JSON.stringify({ direction: "received" }));
  assert.match(received, /1 found/);
  assert.match(received, /received 2,000\.00 USD/);

  const uber = await toolbox(plaid).run("plaid_transactions", JSON.stringify({ search: "transportation" }));
  assert.match(uber, /Uber/);
  assert.doesNotMatch(uber, /Starbucks/);
});

await check("a bank that failed is listed as not included", async () => {
  const plaid = new FakePlaid(
    [chase],
    [
      { bank: "Chase", items: [transaction({})], problem: null },
      { bank: "Amex", items: [], problem: "Amex needs the caller to sign in again." },
    ],
  );
  const output = await toolbox(plaid).run("plaid_transactions", "{}");
  assert.match(output, /Not included: Amex needs the caller to sign in again/);
});

await check("balances say owed for a card and name the account's last digits", async () => {
  const plaid = new FakePlaid([chase], [], [
    {
      bank: "Chase",
      problem: null,
      items: [
        { bank: "Chase", name: "Sapphire", mask: "9876", type: "credit", subtype: "credit card", current: 420.1, available: 4579.9, limit: 5000, currency: "USD" },
        { bank: "Chase", name: "Checking", mask: "1234", type: "depository", subtype: "checking", current: 1500, available: 1450, limit: null, currency: "USD" },
      ],
    },
  ]);
  const output = await toolbox(plaid).run("plaid_list_accounts", "{}");
  assert.match(output, /Sapphire ending 9876 \(credit card\): owed 420\.10 USD/);
  assert.match(output, /Checking ending 1234 \(checking\): current 1,500\.00 USD, available 1,450\.00 USD/);
});

/* ------------------------------------------------------------ date ranges */

await check("no dates means the last 30 days up to today", () => {
  assert.deepEqual(dateRange("", "", NOW), { start: "2026-08-27", end: "2026-09-26" });
});

await check("a future end date stops at today and reversed dates are swapped", () => {
  assert.deepEqual(dateRange("2026-09-10", "2027-01-01", NOW), { start: "2026-09-10", end: "2026-09-26" });
  assert.deepEqual(dateRange("2026-09-10", "2026-09-01", NOW), { start: "2026-09-01", end: "2026-09-10" });
});

await check("a malformed date is refused and history stops at two years", () => {
  assert.equal(typeof dateRange("last month", "", NOW), "string");
  assert.deepEqual(dateRange("2020-01-01", "2026-01-01", NOW), { start: "2024-09-26", end: "2026-01-01" });
});

/* --------------------------------------------------------------- errors */

await check("a lapsed login is a sign-in sentence, and a new bank says it's still loading", () => {
  const login = new PlaidApiError("ITEM_LOGIN_REQUIRED", "ITEM_ERROR", null, "x");
  assert.ok(login.needsLogin);
  assert.match(problemSentence("Chase", login), /sign in again/);
  const loading = new PlaidApiError("PRODUCT_NOT_READY", "ITEM_ERROR", null, "x");
  assert.match(problemSentence("Chase", loading), /still fetching/);
});

/* ------------------------------------------------------- token sealing */

await check("a sealed token opens only for the item and user it was sealed for", async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const sealed = await sealToken(key, "access-sandbox-abc", "item-1", "user-1");
  assert.ok(!sealed.includes("access-sandbox-abc"));
  assert.equal(await openToken(key, sealed, "item-1", "user-1"), "access-sandbox-abc");
  await assert.rejects(openToken(key, sealed, "item-1", "user-2"));
  await assert.rejects(openToken(key, sealed, "item-2", "user-1"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
