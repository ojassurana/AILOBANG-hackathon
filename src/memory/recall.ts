/**
 * Reading memory: Jev routes, Vector Search finds the skills.
 *
 * One Jev choice — does the latest request need personal memory, workflow
 * memory, both, or neither. Then, per branch, Atlas Vector Search returns the
 * closest skills by meaning. No walk, no second Jev pass over the hits.
 */

import { choiceOf, type JevClient } from "./jev";
import type { MemoryNode, MemoryRepo } from "./repo";
import { BRANCHES, type Branch } from "./paths";

/** A confident "none" from the router ends the read; below this, both branches are tried. */
export const ROUTE_CONFIDENCE = 0.5;
/** Skills handed to the harness per branch, nearest first. */
const MAX_SKILLS = 6;
const CONVERSATION_CHARS = 2500;

export type ReadRoute = "none" | "personal" | "workflow" | "both";

export interface RecallResult {
  route: ReadRoute;
  confidence: number;
  personal: MemoryNode[];
  workflow: MemoryNode[];
  /** What was searched, for the log and the page. */
  trail: string[];
}

export interface RecallDeps {
  repo: Pick<MemoryRepo, "search" | "touch" | "log">;
  jev: JevClient;
  userId: string;
}

export const EMPTY_RECALL: RecallResult = { route: "none", confidence: 1, personal: [], workflow: [], trail: [] };

export async function recall(deps: RecallDeps, request: string, conversation: string): Promise<RecallResult> {
  const ask = request.trim();
  if (!ask) return EMPTY_RECALL;
  const context = conversation.slice(-CONVERSATION_CHARS);

  const routed = await deps.jev(
    { latest_request: ask, conversation: context },
    {
      route: {
        type: "choice",
        instructions:
          "Which kind of stored memory about this caller, if any, would help answer or carry out `latest_request`? " +
          "Personal memory holds who the people in their life are, where they live, what they like and how they want things done. " +
          "Workflow memory holds saved procedures for multi-step jobs done before with their apps (documents, messages, calendar, spreadsheets, searches).",
        criteria: {
          none: "The request needs no stored memory: a greeting, small talk, a general question, or everything needed is said in the conversation itself.",
          personal: "The request refers to a person, place, preference or habit of the caller's that is not spelled out in the conversation (a name they want to message, share with or send to, 'my sister', 'the usual', 'like last time').",
          workflow: "The request is a multi-step job with their apps that may have been done before, and needs no personal detail beyond what was said.",
          both: "The request is a job with their apps that also names a person, place or preference. Sharing, sending or messaging someone is both — not only a job, and not only a person.",
        },
      },
    },
  );
  const route = choiceOf(routed.answers, "route");
  const choice = (route?.choice ?? "none") as ReadRoute;
  const confidence = route?.confidence ?? 0;

  const trail: string[] = [`route=${choice}@${confidence.toFixed(2)}`];
  if (choice === "none" && confidence > ROUTE_CONFIDENCE) {
    return { ...EMPTY_RECALL, trail };
  }

  const branches: Branch[] =
    choice === "both" || choice === "none" || confidence <= ROUTE_CONFIDENCE ? [...BRANCHES] : [choice];

  const found: Record<Branch, MemoryNode[]> = { personal: [], workflow: [] };
  for (const branch of branches) {
    found[branch] = await nearestSkills(deps, branch, ask, trail);
  }

  const used = [...found.personal, ...found.workflow].map((node) => node.path);
  await Promise.all([
    deps.repo.touch(deps.userId, used),
    deps.repo.log({
      userId: deps.userId,
      op: "recall",
      source: "harness",
      path: null,
      detail: { request: ask.slice(0, 300), route: choice, confidence, found: used, trail },
    }),
  ]).catch(() => undefined);

  return { route: choice, confidence, personal: found.personal, workflow: found.workflow, trail };
}

/** Closest skills in one branch by meaning. Ranked by Atlas, taken as-is. */
async function nearestSkills(deps: RecallDeps, branch: Branch, request: string, trail: string[]): Promise<MemoryNode[]> {
  let hits: { node: MemoryNode; score: number }[] = [];
  try {
    hits = await deps.repo.search(deps.userId, request, { branch, kind: "skill", limit: MAX_SKILLS });
  } catch (error) {
    trail.push(`${branch} search failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const skills = hits.filter((hit) => hit.node.kind === "skill").slice(0, MAX_SKILLS);
  trail.push(
    `${branch} search: ${skills.map((hit) => `${hit.node.path}@${hit.score.toFixed(2)}`).join(", ") || "(none)"}`,
  );
  return skills.map((hit) => hit.node);
}
