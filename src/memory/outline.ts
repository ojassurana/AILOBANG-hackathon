/**
 * Text renderings of the tree: the outline the writer model plans against,
 * and the brief GPT-Live is handed at the start of a call.
 */

import type { MemoryNode } from "./repo";

const OUTLINE_CONTENT_CHARS = 280;

/**
 * The whole branch as an indented list, folders and skills, with each skill's
 * content cut short. The writer reuses paths from here rather than inventing
 * near-duplicates, and merges into content it can see.
 */
export function renderOutline(nodes: MemoryNode[], maxChars = 7000): string {
  if (!nodes.length) return "(empty)";
  const lines: string[] = [];
  for (const node of [...nodes].sort((a, b) => a.path.localeCompare(b.path))) {
    const depth = node.path.split("/").length - 2;
    const indent = "  ".repeat(Math.max(0, depth));
    if (node.kind === "folder") {
      lines.push(`${indent}${node.path}/ — ${node.summary || node.title}`);
    } else {
      const body = node.content.replace(/\s+/g, " ").trim();
      const shown = body.length > OUTLINE_CONTENT_CHARS ? `${body.slice(0, OUTLINE_CONTENT_CHARS)}…` : body;
      const meta = [
        node.tools.length ? `tools: ${node.tools.join(", ")}` : "",
        node.inputs.length ? `inputs: ${node.inputs.join(", ")}` : "",
        node.code ? "has code" : "",
      ]
        .filter(Boolean)
        .join("; ");
      lines.push(`${indent}${node.path} [skill v${node.version}${meta ? `; ${meta}` : ""}] — ${node.summary}${shown ? ` | ${shown}` : ""}`);
    }
  }
  return truncate(lines.join("\n"), maxChars);
}

/**
 * What the voice assistant should know before it says hello: the personal
 * skills, as plain sentences, most recently used first. Workflows are not
 * here; the backend reads those when it does the work.
 */
export function renderBrief(nodes: MemoryNode[], maxChars = 2500): string {
  const skills = nodes
    .filter((node) => node.branch === "personal" && node.kind === "skill" && node.content.trim())
    .sort((a, b) => (b.lastUsedAt ?? b.updatedAt).localeCompare(a.lastUsedAt ?? a.updatedAt));
  if (!skills.length) return "";
  const lines = skills.map((node) => `- ${node.title}: ${node.content.replace(/\s+/g, " ").trim()}`);
  return truncate(lines.join("\n"), maxChars);
}

/** A recalled node as the backend model should see it. */
export function renderRecalled(node: MemoryNode): string {
  const parts = [`[${node.path}] ${node.title}${node.summary ? ` — ${node.summary}` : ""}`];
  if (node.content.trim()) parts.push(node.content.trim());
  if (node.tools.length) parts.push(`Tools: ${node.tools.join(", ")}`);
  if (node.inputs.length) parts.push(`Inputs: ${node.inputs.join(", ")}`);
  if (node.code) parts.push(`Program (fill the inputs, then run it with run_code):\n${node.code}`);
  return parts.join("\n");
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n… (more not shown)` : value;
}
