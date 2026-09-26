/**
 * The bank tools the backend harness can call.
 *
 * They read the banks the caller linked through Plaid (`src/plaid.ts`), which
 * Composio knows nothing about, so these are the only way the harness reaches
 * them. Both are read-only: Plaid was asked for transactions and nothing that
 * moves money, so there is no tool to pay or transfer and the descriptions say
 * so rather than let the model promise one.
 *
 * Totals are added up here rather than left to the model. A spoken "you spent
 * $412 on food" has to be the real sum of the rows, and the rows themselves are
 * cut to what a spoken answer can carry long before the sum is.
 */

import type { ToolSchema } from "./deepseek";
import type { AccountBalance, BankResult, BankTransaction, PlaidActions } from "./plaid";

const LIST_ACCOUNTS = "plaid_list_accounts";
const TRANSACTIONS = "plaid_transactions";

const DEFAULT_DAYS = 30;
/** Plaid holds at most two years; asking for more returns nothing extra. */
const MAX_DAYS = 730;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The tool schemas, dated so the model can turn "last month" into a range. */
export function plaidTools(now: Date = new Date()): ToolSchema[] {
  const today = isoDate(now);
  return [
    {
      type: "function",
      function: {
        name: LIST_ACCOUNTS,
        description:
          "List the bank, card and loan accounts the caller linked through Plaid, with each one's " +
          "balance: current, available and credit limit. For a credit card or loan the current " +
          "balance is what they owe. Read-only: nothing here can pay, transfer or move money.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: TRANSACTIONS,
        description:
          `Find the caller's bank and card transactions between two dates (today is ${today}) and ` +
          "add them up. Filter by merchant, description or category text, by account, and by " +
          "direction. Returns the total spent and received for everything that matched, then the " +
          "newest matches. Use the totals for questions like how much they spent on something; " +
          "never add up the listed rows yourself, since the list is cut short. Read-only.",
        parameters: {
          type: "object",
          properties: {
            start_date: {
              type: "string",
              description: `First day to include, YYYY-MM-DD. Defaults to ${DEFAULT_DAYS} days before end_date.`,
            },
            end_date: { type: "string", description: `Last day to include, YYYY-MM-DD. Defaults to today (${today}).` },
            search: {
              type: "string",
              description:
                "Words to match in the merchant, description or category, e.g. \"starbucks\", \"uber\", " +
                "\"groceries\", \"rent\". Leave out to include everything.",
            },
            account: {
              type: "string",
              description: "Only this account: part of its name, its bank's name, or its last four digits.",
            },
            direction: {
              type: "string",
              enum: ["all", "spent", "received"],
              description: "spent for money out, received for money in. Defaults to all.",
            },
            limit: {
              type: "integer",
              description: `How many matching transactions to list. Defaults to ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.`,
            },
          },
        },
      },
    },
  ];
}

const TOOL_NAMES = new Set([LIST_ACCOUNTS, TRANSACTIONS]);

export function isPlaidTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

/** Runs one bank tool and returns the text the model reasons over. */
export class PlaidToolbox {
  /** Null when the site has no Plaid keys, which is a different answer from "nothing linked". */
  constructor(
    private readonly plaid: PlaidActions | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  handles(name: string): boolean {
    return isPlaidTool(name);
  }

  async run(name: string, rawArguments: string): Promise<string> {
    if (!this.plaid) {
      return "Bank linking isn't set up on Ailobang yet, so no bank can be read. Tell the caller that plainly.";
    }
    const banks = await this.plaid.banks();
    if (!banks.length) {
      return (
        "The caller hasn't linked a bank, so there are no balances or transactions to read. Tell them " +
        "to link one from the Plaid row on their accounts page: they pick their bank and sign in there."
      );
    }

    switch (name) {
      case LIST_ACCOUNTS:
        return this.listAccounts();
      case TRANSACTIONS:
        return this.transactions(rawArguments);
      default:
        return `There is no bank tool called ${name}.`;
    }
  }

  private async listAccounts(): Promise<string> {
    const results = await this.plaid!.balances();
    const lines: string[] = ["The caller's linked accounts and balances."];
    for (const result of results) {
      if (result.problem) continue;
      lines.push(`${result.bank}:`);
      if (!result.items.length) lines.push("  (no accounts)");
      for (const account of result.items) lines.push(`  ${describeBalance(account)}`);
    }
    lines.push(...problems(results));
    return lines.join("\n");
  }

  private async transactions(rawArguments: string): Promise<string> {
    const args = parseArguments(rawArguments);
    const range = dateRange(text(args.start_date), text(args.end_date), this.now());
    if (typeof range === "string") return range;

    const search = text(args.search).toLowerCase();
    const account = text(args.account).toLowerCase();
    const direction = text(args.direction) || "all";
    const limit = clamp(args.limit);

    const results = await this.plaid!.transactions(range.start, range.end);
    const matched = results
      .flatMap((result) => result.items)
      .filter((row) => !search || haystack(row).includes(search))
      .filter((row) => !account || accountHaystack(row).includes(account))
      .filter((row) => (direction === "spent" ? row.amount > 0 : direction === "received" ? row.amount < 0 : true))
      .sort((a, b) => b.date.localeCompare(a.date));

    const filters = [
      search ? `matching "${text(args.search)}"` : "",
      account ? `in "${text(args.account)}"` : "",
      direction !== "all" ? `money ${direction === "spent" ? "out" : "in"} only` : "",
    ].filter(Boolean);
    const lines = [
      `Transactions from ${range.start} to ${range.end}${filters.length ? `, ${filters.join(", ")}` : ""}: ` +
        `${matched.length} found.`,
    ];
    if (matched.length) {
      lines.push(...totals(matched));
      const shown = matched.slice(0, limit);
      lines.push(`Newest first, showing ${shown.length} of ${matched.length}:`);
      lines.push(...shown.map(describeTransaction));
    }
    lines.push(...problems(results));
    return lines.join("\n");
  }
}

function describeBalance(account: AccountBalance): string {
  const name = `${account.name}${account.mask ? ` ending ${account.mask}` : ""}`;
  const kind = account.subtype ?? account.type;
  const owed = account.type === "credit" || account.type === "loan";
  const parts = [
    account.current !== null ? `${owed ? "owed" : "current"} ${money(account.current, account.currency)}` : "",
    account.available !== null ? `available ${money(account.available, account.currency)}` : "",
    account.limit !== null ? `limit ${money(account.limit, account.currency)}` : "",
  ].filter(Boolean);
  return `${name} (${kind}): ${parts.join(", ") || "no balance reported"}`;
}

function describeTransaction(row: BankTransaction): string {
  const flow = row.amount > 0 ? `spent ${money(row.amount, row.currency)}` : `received ${money(-row.amount, row.currency)}`;
  return [
    row.date,
    row.merchant ?? row.name,
    flow,
    row.category ?? "",
    `${row.bank} ${row.account}${row.accountMask ? ` ending ${row.accountMask}` : ""}`,
    row.pending ? "pending" : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/** Spent and received per currency, since adding dollars to pounds is no total. */
function totals(rows: BankTransaction[]): string[] {
  const byCurrency = new Map<string, { spent: number; received: number }>();
  for (const row of rows) {
    const key = row.currency ?? "";
    const sum = byCurrency.get(key) ?? { spent: 0, received: 0 };
    if (row.amount > 0) sum.spent += row.amount;
    else sum.received -= row.amount;
    byCurrency.set(key, sum);
  }
  return [...byCurrency].map(
    ([currency, sum]) =>
      `Total spent: ${money(sum.spent, currency || null)}. Total received: ${money(sum.received, currency || null)}.`,
  );
}

/** Banks that could not answer, each with its own reason, so none drops out silently. */
function problems<T>(results: BankResult<T>[]): string[] {
  return results.filter((result) => result.problem).map((result) => `Not included: ${result.problem}`);
}

function haystack(row: BankTransaction): string {
  return `${row.name} ${row.merchant ?? ""} ${row.category ?? ""}`.toLowerCase();
}

function accountHaystack(row: BankTransaction): string {
  return `${row.bank} ${row.account} ${row.accountMask ?? ""}`.toLowerCase();
}

/** The range to ask Plaid for, or the sentence to hand back when it cannot be one. */
export function dateRange(
  start: string,
  end: string,
  now: Date,
): { start: string; end: string } | string {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (start && !pattern.test(start)) return `start_date must be YYYY-MM-DD, not "${start}".`;
  if (end && !pattern.test(end)) return `end_date must be YYYY-MM-DD, not "${end}".`;

  const today = isoDate(now);
  let last = end && end < today ? end : today;
  let first = start || isoDate(new Date(Date.parse(last) - DEFAULT_DAYS * DAY_MS));
  if (first > last) [first, last] = [last, first];

  const earliest = isoDate(new Date(Date.parse(today) - MAX_DAYS * DAY_MS));
  if (first < earliest) first = earliest;
  if (last < earliest) return `Plaid only keeps the last two years, so nothing before ${earliest} can be read.`;
  return { start: first, end: last };
}

function money(value: number, currency: string | null): string {
  const amount = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${amount} ${currency}` : amount;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clamp(value: unknown): number {
  if (value === null || value === undefined || value === "") return DEFAULT_LIMIT;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}
