/**
 * Tests for the memory tree's pure parts: how paths are cleaned, how the
 * writer's plan is validated, how Jev's answers are read, and how a recall
 * and a consolidation route through Jev with the database and the models
 * faked. What is at stake: a bad path from a model must never reach Atlas, and
 * a Jev answer under the bar must never write anything.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { findContacts } from "../src/memory/contacts";
import { consolidate, WRITE_CONFIDENCE } from "../src/memory/consolidate";
import { parseAnswers, type JevAnswer, type JevClient, type JevQuestion } from "../src/memory/jev";
import { renderBrief, renderOutline } from "../src/memory/outline";
import { ancestorsOf, normalizePath, parentOf, slugify, titleFromSlug } from "../src/memory/paths";
import { recall } from "../src/memory/recall";
import { searchTextFor, type MemoryNode } from "../src/memory/repo";
import { renderRecall } from "../src/memory/tool";
import { parseWritePlan, type Writer } from "../src/memory/writer";
import { latestRequest } from "../src/harness";

let passed = 0;
let failed = 0;
const checks: Promise<void>[] = [];

function check(name: string, run: () => Promise<void> | void) {
  checks.push(
    Promise.resolve()
      .then(run)
      .then(() => {
        passed++;
        console.log(`  ok   ${name}`);
      })
      .catch((error) => {
        failed++;
        console.log(`  FAIL ${name}`);
        console.log(`       ${error instanceof Error ? error.message : String(error)}`);
      }),
  );
}

/* ------------------------------------------------------------------ paths */

check("slugify lower-cases, strips punctuation and caps length", () => {
  assert.equal(slugify("Sister (Priya)"), "sister-priya");
  assert.equal(slugify("  Google Docs → Telegram  "), "google-docs-telegram");
  assert.equal(slugify("!!!"), "");
  assert.equal(slugify("a".repeat(60)).length, 40);
});

check("normalizePath keeps only paths under a root, at a sane depth", () => {
  assert.equal(normalizePath("Personal/Relationships/Family/Priya"), "personal/relationships/family/priya");
  assert.equal(normalizePath("personal"), null);
  assert.equal(normalizePath("people/priya"), null);
  assert.equal(normalizePath("workflow/a/b/c/d/e/f"), null);
  assert.equal(normalizePath("workflow//docs//send"), "workflow/docs/send");
  // The branch pins the root: a workflow path cannot be filed as personal.
  assert.equal(normalizePath("workflow/docs/send", "personal"), null);
  assert.equal(normalizePath("personal/travel", "personal"), "personal/travel");
});

check("findContacts pairs a spoken name with the address the tools used", () => {
  const found = findContacts(
    "Caller: Share it with uh Himanshu. Yeah, email is Himanshu Sharma four nine two X at gmail dot com",
    "GOOGLESUPER_CREATE_PERMISSION email_address=HimanshuSharma492X@gmail.com",
  );
  assert.deepEqual(found, [{ name: "Himanshu", email: "himanshusharma492x@gmail.com" }]);
});

check("findContacts reads a spoken address when the tools did not spell it", () => {
  const found = findContacts("Caller: send it to pandaHD75 at gmail dot com", null);
  assert.equal(found.length, 1);
  assert.equal(found[0].email, "pandahd75@gmail.com");
});

check("parentOf, ancestorsOf and titleFromSlug", () => {
  assert.equal(parentOf("personal/relationships/family/priya"), "personal/relationships/family");
  assert.equal(parentOf("personal/travel"), "personal");
  assert.deepEqual(ancestorsOf("personal/relationships/family/priya"), ["personal/relationships", "personal/relationships/family"]);
  assert.deepEqual(ancestorsOf("personal/travel"), []);
  assert.equal(titleFromSlug("schedule-lunch"), "Schedule lunch");
});

/* ------------------------------------------------------------------- jev */

check("parseAnswers keeps well-formed choice and noul answers and drops the rest", () => {
  const answers = parseAnswers({
    route: { type: "choice", choice: "personal", confidence: 0.91, probabilities: { personal: 0.93, none: 0.05, workflow: 0.02 } },
    c0: { type: "noul", noul: 0.8 },
    junk: { type: "score", score: 2 },
    broken: { type: "choice" },
  });
  assert.deepEqual(Object.keys(answers).sort(), ["c0", "route"]);
  assert.equal((answers.route as { choice: string }).choice, "personal");
  assert.equal((answers.c0 as { noul: number }).noul, 0.8);
});

/* ---------------------------------------------------------------- writer */

check("parseWritePlan validates paths, drops empty skills, and puts folders first", () => {
  const plan = parseWritePlan(
    JSON.stringify({
      note: "kept the sister",
      operations: [
        { op: "upsert", path: "personal/relationships/family/priya", kind: "skill", title: "Priya", summary: "Sister", content: "Priya is the caller's sister and lives in Boston." },
        { op: "upsert", path: "personal/relationships/family", kind: "folder", title: "Family", summary: "Relatives" },
        { op: "upsert", path: "workflow/docs/send", kind: "skill", content: "wrong branch" },
        { op: "upsert", path: "personal/empty", kind: "skill", content: "" },
        { op: "delete", path: "personal/old" },
        { op: "explode", path: "personal/x" },
        { op: "upsert", path: "personal/relationships/family/priya", kind: "skill", content: "duplicate path" },
      ],
    }),
    "personal",
  );
  assert.equal(plan.note, "kept the sister");
  assert.deepEqual(
    plan.operations.map((op) => `${op.op} ${op.path} ${op.kind}`),
    ["upsert personal/relationships/family folder", "upsert personal/relationships/family/priya skill", "delete personal/old skill"],
  );
});

check("parseWritePlan survives fenced JSON and garbage", () => {
  const fenced = parseWritePlan('```json\n{"operations":[{"op":"upsert","path":"workflow/docs/send","kind":"skill","content":"steps","code":"return 1;","inputs":["recipient"],"tools":["GOOGLEDOCS_CREATE_DOCUMENT"]}]}\n```', "workflow");
  assert.equal(fenced.operations.length, 1);
  assert.equal(fenced.operations[0].code, "return 1;");
  assert.deepEqual(fenced.operations[0].inputs, ["recipient"]);
  assert.equal(fenced.operations[0].title, "Send");
  assert.deepEqual(parseWritePlan("not json", "personal").operations, []);
});

/* ------------------------------------------------------------- rendering */

function node(partial: Partial<MemoryNode> & Pick<MemoryNode, "path" | "kind">): MemoryNode {
  const segments = partial.path.split("/");
  return {
    userId: "u1",
    branch: segments[0] as MemoryNode["branch"],
    kind: partial.kind,
    path: partial.path,
    parentPath: segments.slice(0, -1).join("/"),
    title: partial.title ?? titleFromSlug(segments[segments.length - 1]),
    summary: partial.summary ?? "",
    content: partial.content ?? "",
    code: partial.code ?? null,
    inputs: partial.inputs ?? [],
    tools: partial.tools ?? [],
    searchText: "",
    version: partial.version ?? 1,
    uses: 0,
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: partial.updatedAt ?? "2026-09-26T00:00:00Z",
    lastUsedAt: partial.lastUsedAt ?? null,
  };
}

check("renderOutline indents by depth and renderBrief lists personal skills only", () => {
  const nodes = [
    node({ path: "personal/relationships", kind: "folder", summary: "People in the caller's life" }),
    node({ path: "personal/relationships/family", kind: "folder" }),
    node({ path: "personal/relationships/family/priya", kind: "skill", title: "Priya", summary: "Sister", content: "Priya is the caller's sister." }),
    node({ path: "workflow/docs/send", kind: "skill", title: "Send doc", summary: "Doc to Telegram", content: "steps", code: "x", tools: ["A"] }),
  ];
  const outline = renderOutline(nodes);
  assert.match(outline, /^personal\/relationships\/ — People/m);
  assert.match(outline, /^  personal\/relationships\/family\//m);
  assert.match(outline, /^    personal\/relationships\/family\/priya \[skill v1\] — Sister \| Priya is the caller's sister\./m);
  assert.match(outline, /tools: A; has code/);

  const brief = renderBrief(nodes);
  assert.equal(brief, "- Priya: Priya is the caller's sister.");
});

check("searchTextFor embeds title, summary and body for skills, title and summary for folders", () => {
  assert.equal(searchTextFor({ kind: "folder", title: "Family", summary: "Relatives", content: "" }), "Family: Relatives");
  assert.equal(
    searchTextFor({ kind: "skill", title: "Priya", summary: "Sister", content: "Lives in Boston.", tools: ["X"], inputs: ["who"] }),
    "Priya: Sister\nLives in Boston.\nTools: X\nInputs: who",
  );
});

check("latestRequest picks the caller's last line", () => {
  assert.equal(latestRequest("Caller: hi\nAssistant: hello\nCaller: text my sister\nAssistant: sure"), "text my sister");
  assert.equal(latestRequest("user: make a doc\nassistant: ok"), "make a doc");
});

/* ---------------------------------------------------------------- recall */

/** A Jev that answers from a script: the route, then each level's nouls. */
function scriptedJev(script: ((questions: Record<string, JevQuestion>) => Record<string, JevAnswer>)[]): JevClient & { calls: number } {
  const client = (async (_state: unknown, questions: Record<string, JevQuestion>) => {
    const step = script[client.calls] ?? (() => ({}));
    client.calls++;
    return { answers: step(questions), costUsd: 0 };
  }) as JevClient & { calls: number };
  client.calls = 0;
  return client;
}

const TREE = [
  node({ path: "personal/relationships", kind: "folder", summary: "People" }),
  node({ path: "personal/travel", kind: "folder", summary: "Trips" }),
  node({ path: "personal/relationships/family", kind: "folder", summary: "Relatives" }),
  node({ path: "personal/relationships/family/priya", kind: "skill", title: "Priya", summary: "Sister", content: "Priya is the caller's sister, @priya_s on Telegram." }),
  node({ path: "personal/relationships/family/dad", kind: "skill", title: "Dad", summary: "Father", content: "Lives in Delhi." }),
];

function fakeRepo(nodes: MemoryNode[]) {
  const touched: string[] = [];
  const logged: unknown[] = [];
  return {
    touched,
    logged,
    children: async (_userId: string, parentPath: string) => nodes.filter((n) => n.parentPath === parentPath),
    search: async () => [],
    touch: async (_userId: string, paths: string[]) => {
      touched.push(...paths);
    },
    log: async (event: unknown) => {
      logged.push(event);
    },
  };
}

check("recall walks the tree level by level, following only what Jev picks", async () => {
  const repo = fakeRepo(TREE);
  const jev = scriptedJev([
    () => ({ route: { type: "choice", choice: "personal", confidence: 0.9, probabilities: {} } }),
    // Level 0: relationships yes, travel no.
    (q) => Object.fromEntries(Object.keys(q).map((id, i) => [id, { type: "noul", noul: i === 0 ? 0.95 : 0.05 } as JevAnswer])),
    // Level 1: family yes.
    () => ({ c0: { type: "noul", noul: 0.9 } }),
    // Level 2: priya (first child) yes, dad no.
    (q) => Object.fromEntries(Object.keys(q).map((id, i) => [id, { type: "noul", noul: i === 0 ? 0.97 : 0.1 } as JevAnswer])),
  ]);

  const result = await recall({ repo, jev, userId: "u1" }, "text my sister", "Caller: text my sister");
  assert.equal(result.route, "personal");
  assert.deepEqual(result.personal.map((n) => n.path), ["personal/relationships/family/priya"]);
  assert.deepEqual(result.workflow, []);
  assert.equal(jev.calls, 4);
  assert.deepEqual(repo.touched, ["personal/relationships/family/priya"]);
  assert.match(renderRecall(result), /About the caller[\s\S]*@priya_s/);
});

check("a confident none from the router reads nothing", async () => {
  const repo = fakeRepo(TREE);
  const jev = scriptedJev([() => ({ route: { type: "choice", choice: "none", confidence: 0.95, probabilities: {} } })]);
  const result = await recall({ repo, jev, userId: "u1" }, "thanks, bye", "Caller: thanks, bye");
  assert.equal(result.personal.length + result.workflow.length, 0);
  assert.equal(jev.calls, 1);
  assert.equal(renderRecall(result), "");
});

check("an unsure router tries both branches rather than guessing", async () => {
  const repo = fakeRepo(TREE);
  const jev = scriptedJev([
    () => ({ route: { type: "choice", choice: "workflow", confidence: 0.3, probabilities: {} } }),
    () => ({ c0: { type: "noul", noul: 0.9 } }),
    () => ({ c0: { type: "noul", noul: 0.9 } }),
    () => ({ c0: { type: "noul", noul: 0.9 } }),
  ]);
  const result = await recall({ repo, jev, userId: "u1" }, "send it to priya", "Caller: send it to priya");
  // The workflow branch is empty so it costs no Jev call; personal is walked.
  assert.deepEqual(result.personal.map((n) => n.path), ["personal/relationships/family/priya"]);
});

/* ----------------------------------------------------------- consolidate */

function fakeWriteRepo(nodes: MemoryNode[]) {
  const writes: string[] = [];
  const removed: string[] = [];
  const logged: { op: string }[] = [];
  return {
    writes,
    removed,
    logged,
    all: async (_userId: string, branch?: string) => nodes.filter((n) => !branch || n.branch === branch),
    get: async (_userId: string, path: string) => nodes.find((n) => n.path === path) ?? null,
    getMany: async (_userId: string, paths: string[]) => nodes.filter((n) => paths.includes(n.path)),
    search: async () => [] as { node: MemoryNode; score: number }[],
    upsert: async (input: { path: string; content: string }) => {
      writes.push(input.path);
      const before = nodes.find((n) => n.path === input.path) ?? null;
      const after = node({ path: input.path, kind: "skill", content: input.content, version: (before?.version ?? 0) + 1 });
      if (before) Object.assign(before, after);
      else nodes.push(after);
      return { before, after, created: !before };
    },
    remove: async (_userId: string, path: string) => {
      const gone = nodes.filter((n) => n.path === path || n.path.startsWith(`${path}/`));
      removed.push(...gone.map((n) => n.path));
      return gone;
    },
    log: async (event: { op: string }) => {
      logged.push(event);
    },
  };
}

/** Jev's answer to the write pass: one probability per branch. */
function saveNouls(personal: number, workflow: number): Record<string, JevAnswer> {
  return { personal: { type: "noul", noul: personal }, workflow: { type: "noul", noul: workflow } };
}

check("consolidate writes nothing when Jev says no to both, or is only at the bar", async () => {
  for (const [personal, workflow] of [[0.1, 0.05], [WRITE_CONFIDENCE, 0.2]] as const) {
    const repo = fakeWriteRepo(TREE);
    let writerCalls = 0;
    const writer: Writer = async () => {
      writerCalls++;
      return { operations: [], note: "" };
    };
    const jev = scriptedJev([() => saveNouls(personal, workflow)]);
    const result = await consolidate({ repo, jev, writer, userId: "u1" }, { source: "call", conversation: "Caller: hi there", work: null });
    assert.equal(result.route, "none");
    assert.equal(result.applied.length, 0, `${personal}/${workflow}`);
    assert.equal(writerCalls, 0);
    assert.equal(repo.logged.filter((e) => e.op === "route").length, 1);
  }
});

check("consolidate applies the writer's plan for the branch Jev chose, and logs each write", async () => {
  const repo = fakeWriteRepo(TREE);
  const seen: string[] = [];
  const writer: Writer = async (input) => {
    seen.push(input.branch);
    assert.match(input.outline, /personal\/relationships\/family\/priya/);
    return {
      note: "moved",
      operations: [
        { op: "upsert", path: "personal/relationships/family/priya", kind: "skill", title: "Priya", summary: "Sister", content: "Priya is the caller's sister, @priya_s on Telegram. She lives in Boston.", code: null, inputs: [], tools: [], reason: "moved" },
        { op: "delete", path: "personal/travel", kind: "folder", title: "", summary: "", content: "", code: null, inputs: [], tools: [], reason: "stale" },
      ],
    };
  };
  const jev = scriptedJev([() => saveNouls(0.92, 0.1)]);

  const result = await consolidate({ repo, jev, writer, userId: "u1" }, { source: "call", conversation: "Caller: my sister Priya moved to Boston", work: null });
  assert.deepEqual(seen, ["personal"]);
  assert.deepEqual(repo.writes, ["personal/relationships/family/priya"]);
  assert.deepEqual(repo.removed, ["personal/travel"]);
  assert.deepEqual(result.applied, ["upsert personal/relationships/family/priya (v2)", "delete personal/travel (1 node)"]);
  assert.deepEqual(repo.logged.map((e) => e.op), ["route", "upsert", "delete"]);
});

check("a new skill that Jev says is the same as an existing one lands on the existing path", async () => {
  const repo = fakeWriteRepo(TREE);
  repo.search = async () => [{ node: TREE[3], score: 0.9 }];
  const writer: Writer = async () => ({
    note: "",
    operations: [
      { op: "upsert", path: "personal/people/sister", kind: "skill", title: "Sister", summary: "The caller's sister", content: "Her sister prefers WhatsApp.", code: null, inputs: [], tools: [], reason: "" },
    ],
  });
  const jev = scriptedJev([
    () => saveNouls(0.9, 0.05),
    () => ({ same: { type: "choice", choice: "e0", confidence: 0.85, probabilities: {} } }),
  ]);
  const result = await consolidate({ repo, jev, writer, userId: "u1" }, { source: "call", conversation: "Caller: my sister prefers WhatsApp", work: null });
  assert.deepEqual(repo.writes, ["personal/relationships/family/priya"]);
  assert.match(result.applied[0], /merged from personal\/people\/sister/);
});

check("a job done for someone new writes both the workflow and the person", async () => {
  const repo = fakeWriteRepo([]);
  const seen: string[] = [];
  const writer: Writer = async (input) => {
    seen.push(input.branch);
    const person = { op: "upsert" as const, path: "personal/relationships/contacts/himanshu", kind: "skill" as const, title: "Himanshu", summary: "Contact", content: "Himanshu Sharma. Email: himanshusharma492x@gmail.com.", code: null, inputs: [], tools: [], reason: "" };
    const job = { op: "upsert" as const, path: "workflow/google-docs/create-and-share", kind: "skill" as const, title: "Create and share a doc", summary: "", content: "Create the doc, then share it with the recipient's email from personal memory.", code: null, inputs: ["title", "recipient_email"], tools: [], reason: "" };
    return { note: "", operations: [input.branch === "personal" ? person : job] };
  };
  const jev = scriptedJev([() => saveNouls(0.8, 0.85)]);
  const result = await consolidate(
    { repo, jev, writer, userId: "u1" },
    { source: "call", conversation: "Caller: share it with Himanshu, his email is himanshusharma492x@gmail.com", work: "GOOGLESUPER_CREATE_PERMISSION ok" },
  );
  assert.equal(result.route, "both");
  assert.deepEqual(seen, ["personal", "workflow"]);
  assert.deepEqual(repo.writes, ["personal/relationships/contacts/himanshu", "workflow/google-docs/create-and-share"]);
});

check("a name plus an email is kept even when Jev calls the turn only a job", async () => {
  const repo = fakeWriteRepo([]);
  const seen: string[] = [];
  const writer: Writer = async (input) => {
    seen.push(input.branch);
    if (input.branch === "workflow") {
      return {
        note: "",
        operations: [
          { op: "upsert", path: "workflow/google-docs/create-and-share", kind: "skill", title: "Create and share", summary: "", content: "Create the doc, then share it with the recipient from personal memory.", code: null, inputs: ["title", "recipient_email"], tools: [], reason: "" },
        ],
      };
    }
    return { note: "", operations: [] };
  };
  const jev = scriptedJev([() => saveNouls(0.1, 0.9)]);
  const result = await consolidate(
    { repo, jev, writer, userId: "u1" },
    {
      source: "call",
      conversation: "Caller: share it with Himanshu, email is Himanshu Sharma four nine two X at gmail dot com",
      work: "GOOGLESUPER_CREATE_PERMISSION email_address=HimanshuSharma492X@gmail.com",
    },
  );
  assert.equal(result.route, "both");
  assert.deepEqual(seen.sort(), ["personal", "workflow"]);
  assert.ok(repo.writes.includes("workflow/google-docs/create-and-share"));
  assert.ok(repo.writes.includes("personal/relationships/contacts/himanshu"), `writes: ${repo.writes.join(",")}`);
});

await Promise.all(checks);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
