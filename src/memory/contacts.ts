/**
 * People the conversation or the tools just taught us how to reach.
 *
 * Jev treats "share this with Himanshu, his email is …" as a job, not a
 * memory of a person. The writer can miss it too. This pulls names and
 * addresses out of the text itself — including a spoken
 * "four nine two X at gmail dot com" — so a contact can be filed even when
 * both models pass.
 */

import { slugify, titleFromSlug } from "./paths";

export interface FoundContact {
  name: string;
  email: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
const SPOKEN_AT = /\bat\s+([A-Za-z0-9-]+)\s+dot\s+([A-Za-z]{2,24})/gi;
const NAMED = /\b(?:with|to)\s+(?:(?:uh+|um+)[,.]?\s+)*([A-Z][a-zA-Z]{1,24}(?:\s+[A-Z][a-zA-Z]{1,24})?)/g;

const DIGITS: Record<string, string> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

const NOT_A_NAME = new Set([
  "google",
  "gmail",
  "telegram",
  "docs",
  "doc",
  "drive",
  "new",
  "york",
  "things",
  "email",
  "okay",
  "yeah",
  "please",
  "first",
  "share",
  "send",
  "create",
]);

const LOCAL_STOP = new Set([
  ...NOT_A_NAME,
  "it",
  "to",
  "with",
  "is",
  "the",
  "and",
  "ok",
  "um",
  "uh",
  "as",
  "a",
  "an",
  "his",
  "her",
  "their",
  "for",
  "my",
  "your",
  "at",
]);

/** Contacts found in the conversation and the work record, emails lower-cased, one per address. */
export function findContacts(conversation: string, work: string | null): FoundContact[] {
  const text = `${conversation}\n${work ?? ""}`;
  const emails = uniqueEmails([...writtenEmails(text), ...spokenEmails(text)]);
  if (!emails.length) return [];
  const names = namesIn(conversation);
  return emails.map((email) => ({ name: nameFor(email, names), email }));
}

export function contactPath(name: string): string {
  return `personal/relationships/contacts/${slugify(name) || "contact"}`;
}

export function contactContent(contact: FoundContact): string {
  return `${contact.name}. Email: ${contact.email}.`;
}

function writtenEmails(text: string): string[] {
  return [...text.matchAll(EMAIL)].map((match) => match[0]);
}

function spokenEmails(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SPOKEN_AT)) {
    const before = text.slice(Math.max(0, match.index! - 80), match.index!);
    const tokens = before.trim().split(/\s+/);
    const local: string[] = [];
    for (let i = tokens.length - 1; i >= 0; i--) {
      const raw = tokens[i].replace(/[.,;:"']+$/g, "");
      if (!raw || LOCAL_STOP.has(raw.toLowerCase()) || !/^[\w.-]+$/.test(raw)) break;
      local.unshift(DIGITS[raw.toLowerCase()] ?? raw);
      if (local.join("").length > 64) break;
    }
    if (!local.length) continue;
    found.push(`${local.join("")}@${match[1]}.${match[2]}`);
  }
  return found;
}

function namesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(NAMED)) {
    const name = match[1].trim();
    const first = name.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (NOT_A_NAME.has(first) || name.length < 2) continue;
    names.push(name);
  }
  return names;
}

function nameFor(email: string, names: string[]): string {
  const local = email.split("@")[0] ?? "";
  const letters = local.toLowerCase().replace(/[^a-z]/g, "");
  const match = names.find((name) => {
    const compact = name.toLowerCase().replace(/[^a-z]/g, "");
    return compact.length >= 3 && (letters.includes(compact) || compact.includes(letters.slice(0, 6)));
  });
  if (match) return match;
  const untilDigit = local.match(/^[A-Za-z]+/)?.[0];
  return untilDigit && untilDigit.length >= 2 ? titleFromSlug(slugify(untilDigit)) : titleFromSlug(slugify(local) || "contact");
}

function uniqueEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of emails) {
    const key = email.toLowerCase();
    if (seen.has(key) || key.endsWith("@example.com")) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
