/**
 * The memory object: one Durable Object per user, and the only thing that
 * talks to MongoDB Atlas.
 *
 * It holds one warm MongoClient across requests (a cold connection from a
 * Worker costs a few hundred milliseconds; a warm query tens), and being one
 * object per user makes it the single writer of that user's tree, so the
 * voice agent and the coding chat cannot write over each other. Everything
 * the agents need — read, search, write, brief — is a method here, called over
 * RPC. Jev and the writer model run here too, so the agents hand over a
 * conversation and get back a decision.
 */

import { DurableObject } from "cloudflare:workers";
import { MongoClient, type Db, type MongoClientOptions } from "mongodb";
import type { Env } from "../env";
import { consolidate, type ConsolidateInput, type ConsolidateResult } from "./consolidate";
import { jevClient } from "./jev";
import { renderBrief, renderOutline } from "./outline";
import { isBranch, normalizePath, type Branch } from "./paths";
import { recall, type RecallResult } from "./recall";
import { DATABASE, MemoryRepo, type CallRecord, type MemoryEvent, type MemoryNode, type NodeInput, type UpsertOutcome } from "./repo";
import { writerClient } from "./writer";

/** The one-off save the harness's memory tool makes, on the caller's say-so. */
export interface DirectWrite {
  path: string;
  kind: "folder" | "skill";
  title: string;
  summary: string;
  content: string;
  code?: string | null;
  inputs?: string[];
  tools?: string[];
  reason: string;
}

export class MemoryStore extends DurableObject<Env> {
  private client: MongoClient | null = null;
  private connecting: Promise<Db> | null = null;

  private get userId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("memory store needs a named id (the user id)");
    return name;
  }

  private async db(): Promise<Db> {
    if (this.client) return this.client.db(DATABASE);
    if (!this.connecting) {
      this.connecting = (async () => {
        const uri = this.env.MONGODB_URI;
        if (!uri) throw new Error("MONGODB_URI is not set");
        // The driver's option type folds in Node's TLS options, which this
        // project's Worker typings do not carry; the cast keeps the compiler
        // out of a shape the runtime handles fine.
        const options = {
          maxPoolSize: 3,
          minPoolSize: 0,
          serverSelectionTimeoutMS: 8000,
          connectTimeoutMS: 8000,
          appName: "ailobang-memory",
        } as unknown as MongoClientOptions;
        const client = new MongoClient(uri, options);
        await client.connect();
        this.client = client;
        return client.db(DATABASE);
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async repo(): Promise<MemoryRepo> {
    return new MemoryRepo(await this.db());
  }

  /* -------------------------------------------------------------- reading */

  /** Jev-routed read for the harness: the memory that bears on the latest request. */
  async recall(request: string, conversation: string): Promise<RecallResult> {
    const repo = await this.repo();
    return recall({ repo, jev: jevClient(this.env.OPENROUTER_API_KEY), userId: this.userId }, request, conversation);
  }

  /** What GPT-Live is told about the caller before the call begins. */
  async brief(): Promise<string> {
    const repo = await this.repo();
    return renderBrief(await repo.all(this.userId, "personal"));
  }

  async search(query: string, branch?: string, limit = 5): Promise<MemoryNode[]> {
    const repo = await this.repo();
    const hits = await repo.search(this.userId, query, { branch: isBranch(branch) ? branch : undefined, limit });
    await repo.touch(this.userId, hits.map((hit) => hit.node.path));
    return hits.map((hit) => hit.node);
  }

  async read(path: string): Promise<MemoryNode | null> {
    const clean = normalizePath(path);
    if (!clean) return null;
    const repo = await this.repo();
    const node = await repo.get(this.userId, clean);
    if (node) await repo.touch(this.userId, [clean]);
    return node;
  }

  async list(parentPath: string): Promise<MemoryNode[]> {
    const clean = isBranch(parentPath) ? parentPath : normalizePath(parentPath);
    if (!clean) return [];
    return (await this.repo()).children(this.userId, clean);
  }

  async outline(branch?: string): Promise<string> {
    const repo = await this.repo();
    return renderOutline(await repo.all(this.userId, isBranch(branch) ? branch : undefined));
  }

  /** The whole tree and recent history, for the memory page. */
  async snapshot(): Promise<{ nodes: MemoryNode[]; events: MemoryEvent[] }> {
    const repo = await this.repo();
    const [nodes, events] = await Promise.all([repo.all(this.userId), repo.recentEvents(this.userId, 60)]);
    return { nodes, events };
  }

  /* -------------------------------------------------------------- writing */

  /** The post-conversation pass: Jev routes, the writer plans, the tree changes. */
  async consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
    const repo = await this.repo();
    const key = this.env.OPENROUTER_API_KEY;
    return consolidate({ repo, jev: jevClient(key), writer: writerClient(key), userId: this.userId }, input);
  }

  /** A write the model asked for by name, or the caller did ("remember that…"). */
  async write(input: DirectWrite, source = "tool"): Promise<UpsertOutcome> {
    const path = normalizePath(input.path);
    if (!path) throw new Error(`"${input.path}" is not a memory path: it must start with personal/ or workflow/`);
    const repo = await this.repo();
    const node: NodeInput = {
      userId: this.userId,
      path,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      content: input.content,
      code: input.code ?? null,
      inputs: input.inputs ?? [],
      tools: input.tools ?? [],
    };
    const outcome = await repo.upsert(node);
    await repo.log({
      userId: this.userId,
      op: "upsert",
      source,
      path,
      detail: { kind: input.kind, created: outcome.created, version: outcome.after.version, reason: input.reason, before: outcome.before?.content ?? null, after: outcome.after.content },
    });
    return outcome;
  }

  async forget(path: string, reason: string, source = "tool"): Promise<string[]> {
    const clean = normalizePath(path);
    if (!clean) throw new Error(`"${path}" is not a memory path`);
    const repo = await this.repo();
    const gone = await repo.remove(this.userId, clean);
    if (gone.length) {
      await repo.log({ userId: this.userId, op: "delete", source, path: clean, detail: { removed: gone.map((node) => node.path), reason } });
    }
    return gone.map((node) => node.path);
  }

  async saveCall(record: Omit<CallRecord, "userId">): Promise<void> {
    await (await this.repo()).saveCall({ ...record, userId: this.userId });
  }

  /** Can the object reach Atlas at all: for the health check and the demo. */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      await (await this.db()).command({ ping: 1 });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export type { Branch, ConsolidateInput, ConsolidateResult, MemoryNode, RecallResult };
