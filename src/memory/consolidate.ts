/**
 * Writing memory: what a conversation leaves behind.
 *
 * Runs after the work, never in the caller's way. Jev makes the first call,
 * one yes/no per branch — is there a personal fact worth keeping, is there a
 * reusable procedure — and a branch at or under the bar is left alone. For each branch it picked, the
 * writer model plans upserts and deletes against the branch's outline. Before
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

  // Two independent questions, not one four-way choice: a job done for someone
  // new is both a procedure and a person, and a single pick files it as one.
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
          "`work_record` shows a job with the caller's apps that took more than one dependent step and succeeded, or the caller said how a kind of job should be done from now on.",
        criteria: {
          true: "A reusable multi-step procedure or a standing instruction about how to do a kind of job.",
          false: "No tools were used, a single simple action, a failed attempt, or a question answered from live data.",
        },
      },
    },
  );
  const probabilities: Record<Branch, number> = {
    personal: noulOf(routed.answers, "personal") ?? 0,
    workflow: noulOf(routed.answers, "workflow") ?? 0,
  };
  const contacts = findContacts(conversation, work);
  const branches = BRANCHES.filter((branch) => probabilities[branch] > WRITE_CONFIDENCE);
  // A name plus how to reach them is always personal memory, even when Jev
  // reads the turn as only a job (that is what happened with Himanshu).
  const forced = contacts.length > 0 && !branches.includes("personal");
  if (forced) branches.push("personal");
  const choice: WriteRoute = branches.length === 2 ? "both" : branches[0] ?? "none";
  const confidence = branches.length
    ? Math.min(...branches.map((branch) => probabilities[branch] || (branch === "personal" && forced ? 1 : 0)))
    : 1 - Math.max(probabilities.personal, probabilities.workflow);

  await deps.repo.log({
    userId: deps.userId,
    op: "route",
    source: input.source,
    path: null,
    detail: {
      route: choice,
      confidence,
      probabilities,
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
