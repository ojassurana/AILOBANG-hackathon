/**
 * The shape of the memory tree, without a database in sight.
 *
 * Memory is a folder tree with two fixed roots, `personal` and `workflow`.
 * Everything under them is made by the agent, so every path it proposes goes
 * through here first: lower-cased, slugged, and checked to sit under a root.
 * Roots are virtual — they are never stored, they are just the first segment
 * of every path and the `parentPath` of every top-level folder.
 */

export const BRANCHES = ["personal", "workflow"] as const;
export type Branch = (typeof BRANCHES)[number];
export type NodeKind = "folder" | "skill";

/** Deep enough for people -> family -> sister; deeper than that is a filing habit, not a memory. */
export const MAX_DEPTH = 5;
const MAX_SEGMENT = 40;

export function isBranch(value: unknown): value is Branch {
  return value === "personal" || value === "workflow";
}

/** "Sister (Priya)" -> "sister-priya". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SEGMENT)
    .replace(/-+$/g, "");
}

/**
 * Cleans a proposed path into a stored one, or returns null when it cannot be
 * one: no root, an unknown root, a root only, or too deep.
 *
 * `branch` pins the root: a path proposed for the personal branch that starts
 * with "workflow/" is rejected rather than quietly moved.
 */
export function normalizePath(input: string, branch?: Branch): string | null {
  const segments = String(input ?? "")
    .split("/")
    .map((segment) => slugify(segment))
    .filter(Boolean);
  if (segments.length < 2) return null;
  const root = segments[0];
  if (!isBranch(root)) return null;
  if (branch && root !== branch) return null;
  if (segments.length - 1 > MAX_DEPTH) return null;
  return segments.join("/");
}

export function branchOf(path: string): Branch {
  const root = path.split("/")[0];
  if (!isBranch(root)) throw new Error(`path has no branch: ${path}`);
  return root;
}

/** "personal/family/priya" -> "personal/family"; a top-level node's parent is its root. */
export function parentOf(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, -1).join("/");
}

/** The folder paths a node needs above it, root excluded, shallowest first. */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  const folders: string[] = [];
  for (let end = 2; end < segments.length; end++) folders.push(segments.slice(0, end).join("/"));
  return folders;
}

export function leafOf(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1];
}

/** "schedule-lunch" -> "Schedule lunch". */
export function titleFromSlug(slug: string): string {
  const words = slug.split("-").filter(Boolean);
  if (!words.length) return slug;
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(" ")}` : "");
}

export function depthOf(path: string): number {
  return path.split("/").length - 1;
}
