/**
 * The writer: the language model that turns a conversation into memory.
 *
 * Jev decides *whether* and *which branch*; it cannot name a folder or write a
 * sentence. This model can. It sees the branch's current outline and the
 * conversation (and, for workflows, the record of what the tools did) and
 * returns a short plan of upserts and deletes as JSON. Every path it proposes
 * is still normalised and checked before anything is written.
 */

import { normalizePath, type Branch } from "./paths";

const CHAT_API = "https://openrouter.ai/api/v1/chat/completions";
export const WRITER_MODEL = "openai/gpt-5.4-mini";
const TIMEOUT_MS = 45000;
const MAX_OPERATIONS = 12;

export interface WriteOp {
  op: "upsert" | "delete";
  path: string;
  kind: "folder" | "skill";
  title: string;
  summary: string;
  content: string;
  code: string | null;
  inputs: string[];
  tools: string[];
  reason: string;
}

export interface WritePlan {
  operations: WriteOp[];
  /** What the model said about the plan, for the event log. */
  note: string;
}

export interface WriterInput {
  branch: Branch;
  /** The branch as it stands, from renderOutline. */
  outline: string;
  conversation: string;
  /** The harness worklog: tool calls and their results, run_code programs included. */
  work: string | null;
  /** Personal skills whose content the model must see in full to merge (path -> content). */
  existing: Record<string, string>;
}

export type Writer = (input: WriterInput) => Promise<WritePlan>;

export function writerClient(apiKey: string, fetchImpl: typeof fetch = fetch): Writer {
  return (input) => planWrites(apiKey, input, fetchImpl);
}

export async function planWrites(apiKey: string, input: WriterInput, fetchImpl: typeof fetch = fetch): Promise<WritePlan> {
  const response = await fetchImpl(CHAT_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://ailobang.com",
      "X-Title": "Ailobang memory",
    },
    body: JSON.stringify({
      model: WRITER_MODEL,
      temperature: 0.1,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.branch === "personal" ? PERSONAL_PROMPT : WORKFLOW_PROMPT },
        { role: "user", content: userContent(input) },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`writer ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const payload = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
  return parseWritePlan(payload.choices?.[0]?.message?.content ?? "", input.branch);
}

/** Validates the model's JSON into operations the repo can apply. Anything malformed is dropped. */
export function parseWritePlan(text: string, branch: Branch): WritePlan {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    return { operations: [], note: "unparseable plan" };
  }
  if (!raw || typeof raw !== "object") return { operations: [], note: "plan was not an object" };

  const body = raw as { operations?: unknown; note?: unknown };
  const list = Array.isArray(body.operations) ? body.operations : [];
  const operations: WriteOp[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (operations.length >= MAX_OPERATIONS) break;
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const op = entry.op === "delete" ? "delete" : entry.op === "upsert" ? "upsert" : null;
    if (!op) continue;
    const path = normalizePath(String(entry.path ?? ""), branch);
    if (!path || seen.has(path)) continue;
    const kind = entry.kind === "folder" ? "folder" : "skill";
    const title = text1(entry.title) || titleFromPath(path);
    const content = text1(entry.content, 4000);
    if (op === "upsert" && kind === "skill" && !content) continue;
    seen.add(path);
    operations.push({
      op,
      path,
      kind,
      title,
      summary: text1(entry.summary, 200),
      content,
      code: typeof entry.code === "string" && entry.code.trim() ? entry.code.slice(0, 12000) : null,
      inputs: stringList(entry.inputs),
      tools: stringList(entry.tools),
      reason: text1(entry.reason, 300),
    });
  }

  // Folders first: a skill's folder should carry the summary the model gave it.
  operations.sort((a, b) => Number(a.kind === "skill") - Number(b.kind === "skill"));
  return { operations, note: text1(body.note, 500) };
}

const SHARED_RULES = `Return only JSON of the form:
{"note": "one line on what you decided", "operations": [ ... ]}
Each operation is one of:
{"op":"upsert","path":"<branch>/<folder>/<...>/<skill>","kind":"skill","title":"...","summary":"one line","content":"...", "code": null, "inputs": [], "tools": [], "reason":"..."}
{"op":"upsert","path":"<branch>/<folder>","kind":"folder","title":"...","summary":"one line what belongs here","reason":"..."}
{"op":"delete","path":"...","reason":"..."}

Rules:
- Paths are lower-case slugs joined by "/", always starting with the branch root. At most 5 levels below the root; usually 2 or 3.
- Reuse the folders and skills in the outline whenever they fit. Create a folder only when nothing in the outline fits, and never a near-duplicate of one that exists (no "family" next to "relatives").
- A skill is the leaf that holds the memory. Update an existing skill by returning the merged content in full: what was known before, corrected by what is new. Never drop a fact just because it was not mentioned this time.
- When the new information contradicts the old, the new wins and the content says the current state, not the history.
- Return an empty operations list when nothing durable was learned. Small talk, one-off requests and things already in the outline unchanged are not memories.
- Never store secrets, passwords, one-time codes, card numbers, or the text of the assistant's own replies.`;

const PERSONAL_PROMPT = `You keep the long-term personal memory of a voice assistant's user, as a folder tree under "personal/".

What counts as personal memory: who the people in their life are and how to reach them (names, relationship, handles as said), where they live and travel, what they do, what they like and dislike, how they want things done for them (tone, length, defaults), routines, plans that recur, and preferences that would change how the assistant acts next time.

Contact details matter most. Whenever the caller names someone and an email address, phone number or handle for them comes up — even only so a task could be done, like sharing a document or sending a message — keep that person with that detail, so next time the name alone is enough. Take the exact spelling from the work record when it has one (a spoken "four nine two X at gmail dot com" is the address the tool call used).

${SHARED_RULES}
- Content is a few plain sentences in the third person ("The caller's sister Priya lives in Boston."). For a contact: who they are if known, and every way to reach them ("Himanshu Sharma. Email: himanshusharma492x@gmail.com. The caller shared a Google Doc with him.").
- When only a name and a contact detail are known, the person still gets a skill; file them under relationships (in a contacts folder unless the relationship is clear).
- One skill per person, place or topic. Put people under a relationships folder (family, friends, work), places under travel or home, habits under routines, taste under preferences, unless the outline already organises them another way.`;

const WORKFLOW_PROMPT = `You keep the workflow memory of a voice assistant's backend, as a folder tree under "workflow/": reusable procedures for multi-step jobs it did with its tools, so the next time takes one step.

You are given the work record: the tool calls the backend made (Composio tool slugs, Telegram, web search, plaid) with their arguments and results, and any run_code program it wrote. A procedure is worth keeping when it took more than one dependent step and succeeded, or when the caller said how they want a kind of task done in future.

${SHARED_RULES}
- Path: workflow/<app or domain>/<task>, e.g. workflow/google-docs/create-and-send-on-telegram.
- Content: the trigger (when to use it), the steps in order, the tool slugs, and what to watch out for (the shape of a result, an argument that must be exact).
- "tools": the tool slugs used. "inputs": the values that change per run (recipient, title, dates, message text).
- "code": when a run_code program did the job, return it rewritten as a template: the body of an async function that reads its inputs from an \`inputs\` object (inputs.recipient, inputs.title ...) and never hard-codes a name, link, id or message from this run. Keep the working calls exactly as they were made. Otherwise null.
- Record what the caller said about how they want the task done as part of the content.
- A workflow is about the job, not the people in it. Never put a person's name, email, phone number or handle in a workflow, and never an example from this run; those belong to personal memory, which is kept separately. Where the job needs a recipient, the step reads "use the recipient's contact from personal memory; ask only if it is not there". When updating an existing workflow that contains such details, remove them.`;

function userContent(input: WriterInput): string {
  const sections = [
    `## Current ${input.branch} memory\n${input.outline}`,
  ];
  const existing = Object.entries(input.existing);
  if (existing.length) {
    sections.push(
      `## Full content of skills that may need merging\n${existing.map(([path, content]) => `### ${path}\n${content}`).join("\n\n")}`,
    );
  }
  sections.push(`## Conversation\n${input.conversation}`);
  if (input.work) sections.push(`## Work record (tool calls and results)\n${input.work}`);
  return sections.join("\n\n");
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

function text1(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 120)).slice(0, 20)
    : [];
}

function titleFromPath(path: string): string {
  const leaf = path.split("/").pop() ?? path;
  const words = leaf.split("-").filter(Boolean);
  return words.length ? words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(" ")}` : "") : leaf;
}
