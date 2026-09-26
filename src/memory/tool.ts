/**
 * The harness's `memory` tool, and the read that happens before the model
 * even starts.
 *
 * Most reads never go through the tool: `MemoryToolbox.recall` runs first,
 * with Jev walking the tree, and what it finds is put in front of the model.
 * The tool is for the rest — the model wanting to look something up by hand,
 * the caller saying "remember that", "forget that", or asking what is known.
 */

import type { ToolSchema } from "../deepseek";
import type { DirectWrite } from "./memory-store";
import { renderRecalled } from "./outline";
import type { MemoryNode } from "./repo";
import type { RecallResult } from "./recall";

export const MEMORY = "memory";
/** How long the pre-run read may take before the run goes on without it. */
const RECALL_TIMEOUT_MS = 6000;

/** What the harness needs of the memory object: the RPC surface, minus the rest. */
export interface MemoryActions {
  recall(request: string, conversation: string): Promise<RecallResult>;
  search(query: string, branch?: string, limit?: number): Promise<MemoryNode[]>;
  read(path: string): Promise<MemoryNode | null>;
  list(parentPath: string): Promise<MemoryNode[]>;
  write(input: DirectWrite, source?: string): Promise<{ created: boolean; after: MemoryNode }>;
  forget(path: string, reason: string, source?: string): Promise<string[]>;
}

export const MEMORY_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: MEMORY,
    description:
      "The caller's long-term memory: a folder tree with two roots, personal/ (people, places, preferences, " +
      "how they want things done) and workflow/ (saved procedures for multi-step jobs, some with a run_code program). " +
      "Relevant memory is already given to you at the top of the request; use this tool when you need more. " +
      "search: find memory by meaning. read: one node by path. list: the children of a folder (use 'personal' or " +
      "'workflow' for a root). save: write a skill — use this the moment you learn how to reach someone " +
      "(personal/relationships/contacts/himanshu) or when the caller tells you to remember something. " +
      "forget: remove a node when the caller asks.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "read", "list", "save", "forget"] },
        query: { type: "string", description: "search: what to look for, in plain words." },
        branch: { type: "string", enum: ["personal", "workflow"], description: "search: limit to one root." },
        path: { type: "string", description: "read/list/save/forget: the node's path, e.g. personal/relationships/family/priya." },
        title: { type: "string", description: "save: a short title." },
        summary: { type: "string", description: "save: one line on what this is." },
        content: { type: "string", description: "save: the memory itself, a few plain sentences." },
        reason: { type: "string", description: "save/forget: why, in a few words (what the caller said)." },
      },
      required: ["action"],
    },
  },
};

export const MEMORY_GUIDANCE = `## Memory
Relevant long-term memory, when there is any, is given at the top of the request under "What you remember". Treat it as true unless the caller corrects it, and use it without asking again: a name in memory with an email or handle is who to message or share with, a saved workflow is how to do the job. When a saved workflow carries a program, fill in its inputs and run it with run_code rather than working the steps out again; if it fails, do the job the ordinary way.

When you learn how to reach someone — an email, a phone number, or a handle — even if they only said it so you could finish a job, save that person to personal memory with the memory tool in the same turn, after the action succeeds. Path like personal/relationships/contacts/himanshu. Content is who they are if you know, and every way to reach them, using the exact spelling the tool used. Next time the name alone should be enough: look them up before asking for the email again.

When the caller tells you to remember or forget something else, do that with the memory tool right away and say so. Do not save small talk or one-off amounts. Do save people and how to reach them.`;

export class MemoryToolbox {
  constructor(private readonly memory: MemoryActions) {}

  handles(name: string): boolean {
    return name === MEMORY;
  }

  /**
   * The pre-run read. Never lets a slow or failed memory stop the run: a call
   * without memory is a call, a call waiting on memory is silence.
   */
  async recall(request: string, conversation: string): Promise<string> {
    try {
      const result = await Promise.race([
        this.memory.recall(request, conversation),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RECALL_TIMEOUT_MS)),
      ]);
      if (!result) return "";
      return renderRecall(result);
    } catch (error) {
      console.error("memory: recall failed", error);
      return "";
    }
  }

  async run(rawArguments: string): Promise<string> {
    const args = parseArguments(rawArguments);
    switch (args.action) {
      case "search": {
        if (!args.query) return "search needs a query.";
        const nodes = await this.memory.search(args.query, args.branch, 6);
        return nodes.length ? nodes.map(renderRecalled).join("\n\n") : "Nothing in memory matches that.";
      }
      case "read": {
        if (!args.path) return "read needs a path.";
        const node = await this.memory.read(args.path);
        return node ? renderRecalled(node) : `There is nothing at ${args.path}.`;
      }
      case "list": {
        const nodes = await this.memory.list(args.path || "personal");
        if (!nodes.length) return `${args.path || "personal"} is empty.`;
        return nodes.map((node) => `${node.path} (${node.kind})${node.summary ? ` — ${node.summary}` : ""}`).join("\n");
      }
      case "save": {
        if (!args.path || !args.content) return "save needs a path and content.";
        const outcome = await this.memory.write(
          {
            path: args.path,
            kind: "skill",
            title: args.title || titleOf(args.path),
            summary: args.summary || args.content.split(/(?<=[.!?])\s/)[0].slice(0, 160),
            content: args.content,
            reason: args.reason || "the caller asked",
          },
          "tool",
        );
        return `Saved ${outcome.after.path} (${outcome.created ? "new" : `updated to v${outcome.after.version}`}).`;
      }
      case "forget": {
        if (!args.path) return "forget needs a path.";
        const gone = await this.memory.forget(args.path, args.reason || "the caller asked", "tool");
        return gone.length ? `Forgot ${gone.join(", ")}.` : `There was nothing at ${args.path}.`;
      }
      default:
        return "memory needs an action: search, read, list, save or forget.";
    }
  }
}

/** The "What you remember" block for the top of a harness request. */
export function renderRecall(result: RecallResult): string {
  const blocks: string[] = [];
  if (result.personal.length) blocks.push(`### About the caller\n${result.personal.map(renderRecalled).join("\n\n")}`);
  if (result.workflow.length) blocks.push(`### Saved workflows\n${result.workflow.map(renderRecalled).join("\n\n")}`);
  if (!blocks.length) return "";
  return `What you remember (from long-term memory; use it, do not ask again):\n${blocks.join("\n\n")}`;
}

interface MemoryArgs {
  action?: string;
  query?: string;
  branch?: string;
  path?: string;
  title?: string;
  summary?: string;
  content?: string;
  reason?: string;
}

function parseArguments(raw: string): MemoryArgs {
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    const pick = (key: keyof MemoryArgs) => (typeof parsed[key] === "string" ? (parsed[key] as string).trim() : undefined);
    return {
      action: pick("action"),
      query: pick("query"),
      branch: pick("branch"),
      path: pick("path"),
      title: pick("title"),
      summary: pick("summary"),
      content: pick("content"),
      reason: pick("reason"),
    };
  } catch {
    return {};
  }
}

function titleOf(path: string): string {
  const leaf = path.split("/").filter(Boolean).pop() ?? path;
  return leaf.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
