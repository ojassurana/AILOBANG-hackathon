/**
 * Writing memory: what a conversation leaves behind.
 *
 * Runs after the work, never in the caller's way. Jev makes the first call:
 * a yes/no for personal, a yes/no for workflow, and a yes/no for both. A
 * branch at or under the bar is left alone unless `both` is above it, in
 * which case personal and workflow are both written. For each branch it
 * picked, the writer model plans upserts and deletes against the branch's outline. Before
 * a new node is created, Vector Search looks for one that already means the
 * same thing and Jev says whether it is the same; if so the write lands there
 * instead, so the tree does not grow twins. Every step is logged.
 */

import { contactContent, contactPath, findContacts, type FoundContact } from "./contacts";
import { choiceOf, noulOf, type JevClient } from "./jev";
import { renderOutline } from "./outline";
import { slugify, type Branch, BRANCHES } from "./paths";
import type { MemoryNode, MemoryRepo } from "./repo";
import type { WriteOp, Writer } from "./writer";

/** Jev's route has to be more concentrated than this before anything is written. */
export const WRITE_CONFIDENCE = 0.5;
/** Two nodes are treated as the same memory when Jev is at least this sure. */
const SAME_CONFIDENCE = 0.5;
const CONVERSATION_CHARS = 6000;
const WORK_CHARS = 8000;

export type WriteRoute = "none" | "personal" | "workflow" | "both";

export interface ConsolidateInput {
  /** Where the conversation came from: "call", "delegation", "chat". */
  source: string;
  conversation: string;
  work: string | null;
}

export interface ConsolidateResult {
  route: WriteRoute;
  confidence: number;
  /** "upsert personal/relationships/family/priya (created)" and the like. */
  applied: string[];
  skipped: string[];
}

export interface ConsolidateDeps {
  repo: Pick<MemoryRepo, "all" | "get" | "getMany" | "search" | "upsert" | "remove" | "log">;
  jev: JevClient;
  writer: Writer;
  userId: string;
}

export async function consolidate(deps: ConsolidateDeps, input: ConsolidateInput): Promise<ConsolidateResult> {
  const conversation = input.conversation.trim().slice(-CONVERSATION_CHARS);
  const work = input.work?.trim().slice(-WORK_CHARS) || null;
  if (!conversation && !work) return { route: "none", confidence: 1, applied: [], skipped: ["nothing to read"] };

  // Independent yes/no questions, including both: a job done for someone new
  // is a procedure and a person, and those must not compete for one slot.
  const routed = await deps.jev(
    { conversation, work_record: work ?? "(no tools were used)" },
    {
      personal: {
        type: "noul",
        instructions:
          "This conversation contains a durable fact about the caller's life worth remembering next time: someone they named together with how to reach them " +
          "(an email address, phone number or handle, even one given only so a task could be done), who a person is to them, where they live or travel, " +
          "what they like, or how they want things done. A name the caller will use again, paired with its contact detail, always counts.",
        criteria: {
          true: "At least one such fact was said or confirmed, and it is not a secret, code or card number.",
          false: "Nothing about the caller's people, places or preferences came up beyond what was already known; only small talk or task mechanics.",
        },
      },
      workflow: {
        type: "noul",
        instructions:
          "`work_record` shows a job with the caller's apps that succeeded and they might ask to do again: " +
          "post, send, share, create, look up and act. One tool call is enough. Do not wait for two steps.",
        criteria: {
          true: "A successful action on their apps, or they said how a kind of job should be done from now on.",
          false: "No tools were used, the action failed, or it was only a question answered from live data.",
        },
      },
      both: {
        type: "noul",
        instructions:
          "This should be written to both personal memory and workflow memory. A job done for a named person " +
          "(share with, send to, message, invite) is both: the person and how to reach them, and the procedure. " +
          "Do not treat that as only a workflow.",
        criteria: {
          true: "A reusable job happened that involved a person, place or preference of the caller's, so both sides should be updated.",
          false: "Only one kind of memory applies, or nothing durable was learned.",
        },
      },
    },
  );
  const probabilities: Record<Branch | "both", number> = {
    personal: noulOf(routed.answers, "personal") ?? 0,
    workflow: noulOf(routed.answers, "workflow") ?? 0,
    both: noulOf(routed.answers, "both") ?? 0,
  };
  const contacts = findContacts(conversation, work);
  const pickedBoth = probabilities.both > WRITE_CONFIDENCE;
  const wanted = new Set<Branch>();
  for (const branch of BRANCHES) {
    if (probabilities[branch] > WRITE_CONFIDENCE || pickedBoth) wanted.add(branch);
  }
  // A name plus how to reach them is always personal memory, even when Jev
  // reads the turn as only a job (that is what happened with Himanshu).
  const forced = contacts.length > 0 && !wanted.has("personal");
  if (contacts.length) wanted.add("personal");
  const branches = BRANCHES.filter((branch) => wanted.has(branch));
  const choice: WriteRoute = branches.length === 2 ? "both" : branches[0] ?? "none";
  const confidence = pickedBoth
    ? probabilities.both
    : branches.length
      ? Math.min(...branches.map((branch) => probabilities[branch] || (branch === "personal" && forced ? 1 : 0)))
      : 1 - Math.max(probabilities.personal, probabilities.workflow, probabilities.both);

  await deps.repo.log({
    userId: deps.userId,
    op: "route",
    source: input.source,
    path: null,
    detail: {
      route: choice,
      confidence,
      probabilities,
      pickedBoth,
      forced,
      contacts: contacts.map((contact) => ({ name: contact.name, email: contact.email })),
      costUsd: routed.costUsd,
    },
  });

  if (!branches.length) {
    return { route: "none", confidence, applied: [], skipped: ["nothing to keep"] };
  }
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const branch of branches) {
    const nodes = await deps.repo.all(deps.userId, branch);
    const plan = await deps.writer({
      branch,
      outline: renderOutline(nodes),
      conversation,
      work: branch === "workflow" ? work : work?.slice(-4000) ?? null,
      existing: Object.fromEntries(
        nodes.filter((node) => node.kind === "skill" && node.content.length > 280).slice(0, 20).map((node) => [node.path, node.content]),
      ),
    });

    for (const op of plan.operations) {
      try {
        const outcome = await apply(deps, branch, op, input.source, confidence);
        (outcome.applied ? applied : skipped).push(outcome.line);
      } catch (error) {
        skipped.push(`${op.op} ${op.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (contacts.length) {
    for (const outcome of await seedContacts(deps, contacts, input.source, confidence)) {
      (outcome.applied ? applied : skipped).push(outcome.line);
    }
  }

  return { route: choice, confidence, applied, skipped };
}

/** Files any contact the writer did not, so a name+email cannot vanish. */
async function seedContacts(
  deps: ConsolidateDeps,
  contacts: FoundContact[],
  source: string,
  routeConfidence: number,
): Promise<{ applied: boolean; line: string }[]> {
  const nodes = await deps.repo.all(deps.userId, "personal");
  const outcomes: { applied: boolean; line: string }[] = [];
  for (const contact of contacts) {
    if (nodes.some((node) => node.kind === "skill" && node.content.toLowerCase().includes(contact.email))) {
      continue;
    }
    const named = nodes.find(
      (node) =>
        node.kind === "skill" &&
        (node.title.toLowerCase() === contact.name.toLowerCase() || node.path.endsWith(`/${slugify(contact.name)}`)),
    );
    const op: WriteOp = {
      op: "upsert",
      path: named?.path ?? contactPath(contact.name),
      kind: "skill",
      title: named?.title ?? contact.name,
      summary: named?.summary || `${contact.name}'s contact`,
      content: named ? mergeEmail(named.content, contact) : contactContent(contact),
      code: null,
      inputs: [],
      tools: [],
      reason: "named with a way to reach them",
    };
    try {
      const outcome = await apply(deps, "personal", op, source, routeConfidence);
      outcomes.push(outcome);
      if (outcome.applied) {
        const after = await deps.repo.get(deps.userId, op.path);
        if (after) nodes.push(after);
      }
    } catch (error) {
      outcomes.push({ applied: false, line: `upsert ${op.path}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return outcomes;
}

function mergeEmail(content: string, contact: FoundContact): string {
  if (content.toLowerCase().includes(contact.email)) return content;
  return `${content.trim()} Email: ${contact.email}.`;
}

async function apply(
  deps: ConsolidateDeps,
  branch: Branch,
  op: WriteOp,
  source: string,
  routeConfidence: number,
): Promise<{ applied: boolean; line: string }> {
  if (op.op === "delete") {
    const gone = await deps.repo.remove(deps.userId, op.path);
    if (!gone.length) return { applied: false, line: `delete ${op.path}: nothing there` };
    await deps.repo.log({
      userId: deps.userId,
      op: "delete",
      source,
      path: op.path,
      detail: { removed: gone.map((node) => node.path), reason: op.reason },
    });
    return { applied: true, line: `delete ${op.path} (${gone.length} node${gone.length === 1 ? "" : "s"})` };
  }

  let target = op.path;
  let content = op.content;
  let merged: string | null = null;

  const existing = await deps.repo.get(deps.userId, op.path);
  if (!existing && op.kind === "skill") {
    // New skill: is there one already that means the same thing, under another name?
    const twin = await findTwin(deps, branch, op);
    if (twin) {
      target = twin.path;
      merged = twin.path;
      if (!twin.content.includes(content)) content = `${twin.content.trim()}\n${content}`.trim();
    }
  }

  const outcome = await deps.repo.upsert({
    userId: deps.userId,
    path: target,
    kind: op.kind,
    title: op.title,
    summary: op.summary || (op.kind === "folder" ? op.title : existingSummary(existing, op)),
    content,
    code: op.code,
    inputs: op.inputs,
    tools: op.tools,
  });

  await deps.repo.log({
    userId: deps.userId,
    op: "upsert",
    source,
    path: target,
    detail: {
      kind: op.kind,
      created: outcome.created,
      version: outcome.after.version,
      mergedInto: merged,
      proposedPath: op.path,
      reason: op.reason,
      routeConfidence,
      before: outcome.before?.content ?? null,
      after: outcome.after.content,
    },
  });

  const how = outcome.created ? "created" : `v${outcome.after.version}`;
  return { applied: true, line: `upsert ${target} (${how}${merged ? `, merged from ${op.path}` : ""})` };
}

/** Looks for an existing skill that is the same memory as the proposed one. */
async function findTwin(deps: ConsolidateDeps, branch: Branch, op: WriteOp): Promise<MemoryNode | null> {
  let hits: MemoryNode[];
  try {
    hits = (await deps.repo.search(deps.userId, `${op.title}: ${op.summary}\n${op.content}`, { branch, kind: "skill", limit: 3 }))
      .map((hit) => hit.node)
      .filter((node) => node.path !== op.path);
  } catch {
    return null;
  }
  if (!hits.length) return null;

  const options: Record<string, string> = { none: "None of the existing memories is about the same thing as the new one." };
  hits.forEach((node, index) => {
    options[`e${index}`] = `The new memory and \`existing[${index}]\` are about the same person, place, topic or procedure and belong in one place.`;
  });

  const result = await deps.jev(
    {
      new_memory: { title: op.title, summary: op.summary, content: op.content.slice(0, 600), proposed_path: op.path },
      existing: hits.map((node) => ({ path: node.path, title: node.title, summary: node.summary, content: node.content.slice(0, 600) })),
    },
    {
      same: {
        type: "choice",
        instructions: "Is `new_memory` about the same thing as one of the memories in `existing`, so that it should update that one rather than be filed separately?",
        criteria: options,
      },
    },
  );
  const answer = choiceOf(result.answers, "same");
  if (!answer || answer.choice === "none" || answer.confidence < SAME_CONFIDENCE) return null;
  const index = Number(answer.choice.slice(1));
  return hits[index] ?? null;
}

function existingSummary(existing: MemoryNode | null, op: WriteOp): string {
  return existing?.summary || op.content.split(/(?<=[.!?])\s/)[0]?.slice(0, 160) || op.title;
}
