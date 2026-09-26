/**
 * The memory tree in MongoDB Atlas.
 *
 * One document per folder or skill in `memory_nodes`, joined into a tree by
 * `path` and `parentPath`. `searchText` is what Atlas Vector Search embeds on
 * write (the index is an auto-embedding one, so no embedding call happens
 * here): a query in plain words finds the nodes closest in meaning. Every
 * change is also appended to `memory_events`, with the Jev decision that led
 * to it, so the tree's history can be read back and shown.
 */

import type { Collection, Db, Filter } from "mongodb";
import { ancestorsOf, parentOf, titleFromSlug, type Branch, type NodeKind } from "./paths";

export const DATABASE = "ailobang";
export const NODES = "memory_nodes";
export const EVENTS = "memory_events";
export const CALLS = "calls";
/** The auto-embedding vector index on `memory_nodes.searchText`. */
export const VECTOR_INDEX = "memory_vector";

export interface MemoryNode {
  userId: string;
  branch: Branch;
  kind: NodeKind;
  path: string;
  parentPath: string;
  title: string;
  /** One line: what is in here. Folders live on this alone. */
  summary: string;
  /** The skill's body. Empty on folders. */
  content: string;
  /** Workflow skills: a parameterised run_code program that did the job before. */
  code: string | null;
  /** Workflow skills: the inputs the program expects, e.g. ["recipient", "title"]. */
  inputs: string[];
  /** Workflow skills: the tool slugs the procedure uses. */
  tools: string[];
  searchText: string;
  version: number;
  uses: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface MemoryEvent {
  userId: string;
  at: string;
  /** What happened: a routing decision, a node written, a node removed, a recall. */
  op: "route" | "upsert" | "delete" | "recall";
  source: string;
  path: string | null;
  detail: Record<string, unknown>;
}

export interface CallRecord {
  userId: string;
  source: string;
  transcript: string;
  work: string | null;
  startedAt: string | null;
  endedAt: string;
}

export type NodeInput = Pick<MemoryNode, "userId" | "path" | "kind" | "title" | "summary" | "content"> &
  Partial<Pick<MemoryNode, "code" | "inputs" | "tools">>;

export interface UpsertOutcome {
  before: MemoryNode | null;
  after: MemoryNode;
  created: boolean;
}

/** A search hit: the node and how close it came. */
export interface Hit {
  node: MemoryNode;
  score: number;
}

export class MemoryRepo {
  private readonly nodes: Collection<MemoryNode>;
  private readonly events: Collection<MemoryEvent>;
  private readonly calls: Collection<CallRecord>;

  constructor(db: Db) {
    this.nodes = db.collection<MemoryNode>(NODES);
    this.events = db.collection<MemoryEvent>(EVENTS);
    this.calls = db.collection<CallRecord>(CALLS);
  }

  async children(userId: string, parentPath: string): Promise<MemoryNode[]> {
    return this.nodes.find({ userId, parentPath }, { projection: { _id: 0 } }).sort({ kind: 1, title: 1 }).limit(200).toArray();
  }

  async get(userId: string, path: string): Promise<MemoryNode | null> {
    return this.nodes.findOne({ userId, path }, { projection: { _id: 0 } });
  }

  async getMany(userId: string, paths: string[]): Promise<MemoryNode[]> {
    if (!paths.length) return [];
    return this.nodes.find({ userId, path: { $in: paths } }, { projection: { _id: 0 } }).toArray();
  }

  /** Every node of a user, or of one branch, path order. Capped: a tree past this is a bug. */
  async all(userId: string, branch?: Branch): Promise<MemoryNode[]> {
    const filter: Filter<MemoryNode> = branch ? { userId, branch } : { userId };
    return this.nodes.find(filter, { projection: { _id: 0 } }).sort({ path: 1 }).limit(1000).toArray();
  }

  /** Finds the nodes closest in meaning to `query`, through the auto-embedding index. */
  async search(userId: string, query: string, options: { branch?: Branch; kind?: NodeKind; limit?: number } = {}): Promise<Hit[]> {
    const limit = options.limit ?? 5;
    const filter: Record<string, unknown> = { userId };
    if (options.branch) filter.branch = options.branch;
    if (options.kind) filter.kind = options.kind;

    const rows = await this.nodes
      .aggregate<MemoryNode & { score: number }>([
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: "searchText",
            query,
            numCandidates: Math.max(20, limit * 10),
            limit,
            filter,
          },
        },
        { $addFields: { score: { $meta: "vectorSearchScore" } } },
        { $project: { _id: 0 } },
      ])
      .toArray();

    return rows.map(({ score, ...node }) => ({ node: node as MemoryNode, score }));
  }

  /**
   * Writes a node, creating the folders above it as needed. A folder that
   * already exists is left alone unless a summary is given for it.
   */
  async upsert(input: NodeInput): Promise<UpsertOutcome> {
    const now = new Date().toISOString();
    const branch = input.path.split("/")[0] as Branch;

    for (const folder of ancestorsOf(input.path)) {
      const exists = await this.nodes.findOne({ userId: input.userId, path: folder }, { projection: { path: 1 } });
      if (exists) continue;
      const title = titleFromSlug(folder.split("/").pop() ?? folder);
      await this.nodes.updateOne(
        { userId: input.userId, path: folder },
        {
          $setOnInsert: {
            userId: input.userId,
            branch,
            kind: "folder",
            path: folder,
            parentPath: parentOf(folder),
            title,
            summary: "",
            content: "",
            code: null,
            inputs: [],
            tools: [],
            searchText: `${title}`,
            version: 1,
            uses: 0,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
          },
        },
        { upsert: true },
      );
    }

    const before = await this.get(input.userId, input.path);
    const next: MemoryNode = {
      userId: input.userId,
      branch,
      kind: input.kind,
      path: input.path,
      parentPath: parentOf(input.path),
      title: input.title,
      summary: input.summary,
      content: input.kind === "folder" ? "" : input.content,
      code: input.kind === "skill" ? input.code ?? null : null,
      inputs: input.kind === "skill" ? input.inputs ?? [] : [],
      tools: input.kind === "skill" ? input.tools ?? [] : [],
      searchText: searchTextFor(input),
      version: (before?.version ?? 0) + 1,
      uses: before?.uses ?? 0,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: before?.lastUsedAt ?? null,
    };
    await this.nodes.replaceOne({ userId: input.userId, path: input.path }, next, { upsert: true });
    return { before, after: next, created: before === null };
  }

  /** Removes a node and, for a folder, everything under it. Returns what went. */
  async remove(userId: string, path: string): Promise<MemoryNode[]> {
    const filter: Filter<MemoryNode> = {
      userId,
      $or: [{ path }, { path: { $regex: `^${escapeRegex(path)}/` } }],
    };
    const gone = await this.nodes.find(filter, { projection: { _id: 0 } }).toArray();
    if (gone.length) await this.nodes.deleteMany(filter);
    return gone;
  }

  /** Marks nodes as recalled: what gets used is what is worth keeping. */
  async touch(userId: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.nodes.updateMany(
      { userId, path: { $in: paths } },
      { $inc: { uses: 1 }, $set: { lastUsedAt: new Date().toISOString() } },
    );
  }

  async log(event: Omit<MemoryEvent, "at">): Promise<void> {
    await this.events.insertOne({ ...event, at: new Date().toISOString() });
  }

  async recentEvents(userId: string, limit = 50): Promise<MemoryEvent[]> {
    return this.events.find({ userId }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
  }

  async saveCall(record: CallRecord): Promise<void> {
    await this.calls.insertOne(record);
  }
}

/** What the vector index embeds: the title and summary, plus the body for a skill. */
export function searchTextFor(node: Pick<NodeInput, "kind" | "title" | "summary" | "content"> & { inputs?: string[]; tools?: string[] }): string {
  const head = node.summary ? `${node.title}: ${node.summary}` : node.title;
  if (node.kind === "folder") return head;
  const extras = [
    node.tools?.length ? `Tools: ${node.tools.join(", ")}` : "",
    node.inputs?.length ? `Inputs: ${node.inputs.join(", ")}` : "",
  ].filter(Boolean);
  return [head, node.content.slice(0, 1500), ...extras].filter(Boolean).join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
