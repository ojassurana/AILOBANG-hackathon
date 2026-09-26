/**
 * Writing memory: what a conversation leaves behind.
 *
 * Runs after the work, never in the caller's way. Jev makes the first call —
 * does this change personal memory, workflow memory, both, or nothing — and a
 * confidence at or under the bar means nothing. For each branch it picked, the
 * writer model plans upserts and deletes against the branch's outline. Before
 * a new node is created, Vector Search looks for one that already means the
 * same thing and Jev says whether it is the same; if so the write lands there
 * instead, so the tree does not grow twins. Every step is logged.
 */

import { choiceOf, type JevClient } from "./jev";
import { renderOutline } from "./outline";
import { type Branch, BRANCHES } from "./paths";
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

  const routed = await deps.jev(
    { conversation, work_record: work ?? "(no tools were used)" },
    {
      route: {
        type: "choice",
        instructions:
          "Did this conversation reveal something worth keeping in the assistant's long-term memory of this caller? " +
          "Personal memory: durable facts about the caller's life — people, places, preferences, routines, how they want things done. " +
          "Workflow memory: a reusable procedure — a multi-step job done with their apps in `work_record`, or an instruction about how such jobs should be done in future.",
        criteria: {
          none: "Nothing durable: small talk, a one-off question answered from live data, a single simple action, or facts the assistant already had.",
          personal: "The caller stated or corrected a durable fact about their life or preferences, and no reusable multi-step procedure happened.",
          workflow: "A multi-step job with tools was completed, or the caller said how a kind of job should be done from now on, with no new personal fact.",
          both: "Both a durable personal fact and a reusable procedure or standing instruction came up.",
        },
      },
    },
  );
  const route = choiceOf(routed.answers, "route");
  const choice = (route?.choice ?? "none") as WriteRoute;
  const confidence = route?.confidence ?? 0;

  await deps.repo.log({
    userId: deps.userId,
    op: "route",
    source: input.source,
    path: null,
    detail: { route: choice, confidence, probabilities: route?.probabilities ?? {}, costUsd: routed.costUsd },
  });

  if (choice === "none" || confidence <= WRITE_CONFIDENCE) {
    return { route: choice, confidence, applied: [], skipped: [confidence <= WRITE_CONFIDENCE ? "route below confidence bar" : "nothing to keep"] };
  }

  const branches: Branch[] = choice === "both" ? [...BRANCHES] : [choice];
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const branch of branches) {
    const nodes = await deps.repo.all(deps.userId, branch);
    const plan = await deps.writer({
      branch,
      outline: renderOutline(nodes),
      conversation,
      work: branch === "workflow" ? work : work?.slice(-2000) ?? null,
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

  return { route: choice, confidence, applied, skipped };
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
