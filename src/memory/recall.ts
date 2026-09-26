/**
 * Reading memory: Jev walks the tree.
 *
 * First one choice — does the caller's latest request need personal memory,
 * workflow memory, both, or neither. Then, per branch, a walk from the root:
 * Jev is shown the children of the folder it is in and says, for each, whether
 * it would help with the request. Folders it picks are walked into, skills it
 * picks are the result. When the walk finds nothing, Vector Search offers the
 * closest nodes by meaning and Jev vets those the same way.
 *
 * Every question is answered in one Jev request per level, so a read costs a
 * handful of fast calls, not a model reasoning over the whole tree.
 */

import { choiceOf, noulOf, type JevClient, type JevQuestion } from "./jev";
import type { MemoryNode, MemoryRepo } from "./repo";
import { BRANCHES, type Branch } from "./paths";

/** Jev must be at least this sure that a node helps before it is followed or returned. */
export const RELEVANT_AT = 0.5;
/** A confident "none" from the router ends the read; below this, both branches are tried. */
export const ROUTE_CONFIDENCE = 0.5;
const MAX_LEVELS = 5;
const MAX_FOLLOW_PER_LEVEL = 3;
const MAX_SKILLS = 6;
const CONVERSATION_CHARS = 2500;

export type ReadRoute = "none" | "personal" | "workflow" | "both";

export interface RecallResult {
  route: ReadRoute;
  confidence: number;
  personal: MemoryNode[];
  workflow: MemoryNode[];
  /** The paths Jev walked, for the log and the page. */
  trail: string[];
}

export interface RecallDeps {
  repo: Pick<MemoryRepo, "children" | "search" | "touch" | "log">;
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
          personal: "The request refers to a person, place, preference or habit of the caller's that is not spelled out in the conversation (a name without a handle, 'my sister', 'the usual', 'like last time').",
          workflow: "The request is a multi-step job with their apps that may have been done before, and needs no personal detail beyond what was said.",
          both: "The request is a multi-step job with their apps and also refers to a person, place or preference not spelled out.",
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
    found[branch] = await walk(deps, branch, ask, context, trail);
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

/** Walks one branch from its root, Jev choosing at every level. */
async function walk(deps: RecallDeps, branch: Branch, request: string, conversation: string, trail: string[]): Promise<MemoryNode[]> {
  const skills: MemoryNode[] = [];
  let frontier: string[] = [branch];

  for (let level = 0; level < MAX_LEVELS && frontier.length && skills.length < MAX_SKILLS; level++) {
    const candidates: MemoryNode[] = [];
    for (const folder of frontier) candidates.push(...(await deps.repo.children(deps.userId, folder)));
    if (!candidates.length) break;

    const picked = await vet(deps.jev, candidates, request, conversation);
    trail.push(`${branch} L${level}: ${picked.map((node) => node.path).join(", ") || "(none)"}`);

    frontier = [];
    for (const node of picked) {
      if (node.kind === "skill") skills.push(node);
      else if (frontier.length < MAX_FOLLOW_PER_LEVEL) frontier.push(node.path);
    }
  }

  if (skills.length) return skills.slice(0, MAX_SKILLS);

  // The walk found nothing: try meaning. A skill filed somewhere Jev did not
  // expect is still found this way.
  let hits: MemoryNode[] = [];
  try {
    hits = (await deps.repo.search(deps.userId, request, { branch, kind: "skill", limit: 4 })).map((hit) => hit.node);
  } catch (error) {
    trail.push(`${branch} search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!hits.length) return [];
  const vetted = await vet(deps.jev, hits, request, conversation);
  trail.push(`${branch} search: ${vetted.map((node) => node.path).join(", ") || "(none)"}`);
  return vetted.filter((node) => node.kind === "skill").slice(0, MAX_SKILLS);
}

/** One Jev request: a noul per candidate, kept when the probability clears the bar. */
async function vet(jev: JevClient, candidates: MemoryNode[], request: string, conversation: string): Promise<MemoryNode[]> {
  const shown = candidates.slice(0, 40);
  const questions: Record<string, JevQuestion> = {};
  shown.forEach((node, index) => {
    questions[`c${index}`] = {
      type: "noul",
      instructions:
        `Would the stored memory \`candidates[${index}]\` help answer or carry out \`latest_request\`? ` +
        "A folder helps when something inside it is likely needed; a skill helps when its content is needed.",
      criteria: {
        true: "The memory is about the person, place, preference, or kind of job the request involves.",
        false: "The memory is about something the request does not touch.",
      },
    };
  });

  const result = await jev(
    {
      latest_request: request,
      conversation,
      candidates: shown.map((node) => ({
        kind: node.kind,
        title: node.title,
        summary: node.summary,
        path: node.path,
        ...(node.kind === "skill" ? { preview: node.content.slice(0, 200) } : {}),
      })),
    },
    questions,
  );

  return shown
    .map((node, index) => ({ node, p: noulOf(result.answers, `c${index}`) ?? 0 }))
    .filter((entry) => entry.p >= RELEVANT_AT)
    .sort((a, b) => b.p - a.p)
    .map((entry) => entry.node);
}
