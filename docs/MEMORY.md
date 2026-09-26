# Long-term memory

The assistant remembers. What it remembers lives in MongoDB Atlas as a folder
tree the agent builds itself; Jev, TypeSafe's decision model, routes every read
and every write; a writer model turns conversations into the tree's contents.
Code in `src/memory/` owns every step in between.

## The tree

Two roots are fixed, `personal/` and `workflow/`. Everything under them is the
agent's doing: folders, subfolders and the leaf documents, called skills.

```
personal/
  relationships/
    family/
      priya            "The caller's sister. @priya_s on Telegram. Lives in Boston."
  preferences/
    messages           "Keeps Telegram messages short, no sign-off."
workflow/
  google-docs/
    create-and-send-on-telegram
                       trigger, steps, tool slugs, inputs, and a run_code template
```

A skill under `personal/` is a few plain sentences. A skill under `workflow/`
is a procedure: when to use it, the steps, the Composio slugs, the inputs that
change per run, and — when a `run_code` program did the job — that program,
rewritten as a template that reads `inputs.recipient`, `inputs.title` and so on.

## In Atlas

Database `ailobang`, on the hackathon sandbox cluster.

| Collection | Holds |
|---|---|
| `memory_nodes` | one document per folder or skill: `userId, branch, kind, path, parentPath, title, summary, content, code, inputs, tools, searchText, version, uses, …` |
| `memory_events` | every Jev route, recall, upsert and delete, with confidence and before/after |
| `calls` | the transcript and work record of each finished call |

Indexes on `memory_nodes`: `{userId, path}`, `{userId, parentPath}` for the
tree walk, and `memory_vector`, an Atlas Vector Search index that
**auto-embeds** `searchText` with `voyage-4-lite` (filters: `userId`, `branch`,
`kind`). No embedding call happens in the Worker: Atlas embeds on write and
takes a plain-text `query` on `$vectorSearch`.

## Reading (`recall.ts`)

Runs in the harness before the model starts, on the caller's latest line.

1. **Route.** One Jev `choice`: `none` / `personal` / `workflow` / `both`.
   A confident `none` ends it. An unsure answer tries both branches.
2. **Walk.** From the branch root, Jev is shown the folder's children and
   answers a `noul` per child — would this help? — in one request per level.
   Folders it picks are walked into; skills it picks are the result.
3. **Fallback.** When the walk finds nothing, Vector Search offers the closest
   skills by meaning and Jev vets them the same way.

What comes back is put at the top of the model's request as "What you
remember". The personal skills are also rendered into GPT-Live's instructions
when a call starts (`brief()`), so the voice knows the caller before hello.

## Writing (`consolidate.ts`)

Runs in the background, after a delegation with tool work and when the call
ends, and after each coding-chat turn. Never on the call's path.

1. **Route.** One Jev `choice` over the conversation and the work record:
   `none` / `personal` / `workflow` / `both`. At or under 50% confidence,
   nothing is written. The decision is logged either way.
2. **Plan.** For each branch chosen, the writer model (through OpenRouter) sees
   the branch's outline and returns upserts and deletes as JSON. Every path is
   normalised and must sit under the branch root; malformed operations drop.
3. **De-duplicate.** Before a new skill is created, Vector Search finds the
   closest existing skills and Jev says whether one is the same memory. If so
   the write lands there, merged, and the tree does not grow twins.
4. **Apply.** Missing folders are created, the skill is written with a version
   bump, and a `memory_events` row records what changed and why.

## Where it plugs in

- `MemoryStore` (`memory-store.ts`) — one Durable Object per user, holding the
  warm `MongoClient`; the single writer of that user's tree. Everything above
  runs inside it, over RPC.
- `ConnectorHarness` — recall before the run; a `memory` tool for search,
  read, list, save (on "remember that…") and forget; `lastWork()` for the pass.
- `VoiceAgent` — `brief()` into the session instructions; `keepMemory()` after
  delegations and at call end; a `memory` page event to the call page.
- `CodingAgent` — same harness, same pass after each turn.
- `/memory` — the tree and the decision log for the signed-in user, polling
  `/memory.json`.

## Secrets

`MONGODB_URI` (the `ailobang-worker` user, readWrite on `ailobang`) and
`OPENROUTER_API_KEY` (Jev as `typesafe/jev-1.13`, writer as
`openai/gpt-5.4-mini`). Without `MONGODB_URI` the agents run without memory.
