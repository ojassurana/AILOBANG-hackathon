# Humanize-and-check: writing a document that does not read as AI

Status: **built, unit-tested, and bundling into the Worker.** Works with no keys
and no paid services. Deploying needs the `ailobang.com` Cloudflare token.

## The flow the caller hears

1. The caller asks for an essay or report.
2. The agent writes it to Google Docs first, so the document is open and visible
   while the rest happens.
3. The agent calls `humanize_and_check`, and the caller hears
   **"Humanizing it now."**
4. The rewritten text gets scored, and the caller hears
   **"Running it past the AI detector."**
5. If it still reads as formulaic, the caller hears
   **"It still reads as AI-written, so I am rewriting it harder."** and the loop
   repeats at a stronger setting.
6. When the score clears, the caller hears
   **"It reads as human-written now. Finished."**
7. The final text is written back into the same document.

Those lines come through the existing `onProgress` callback in `src/harness.ts`,
the same channel that already produces "Fetching that now" during a call, so
GPT-Live speaks them with no new plumbing.

## The humanizer

`src/humanize.ts`, built on **blader/humanizer** from the skills.sh registry:
MIT, about 50k stars, the highest-usage humanizer there. It won because it is a
structured checklist of 25 named tells rather than prose advice.

| Skill | Why not the default |
| --- | --- |
| `aboudjem/humanizer-skill` | 55 patterns and a 0-100 self-score, but that score is its own opinion. Scoring yourself to satisfy an outside checker is circular. Its escalation styles are borrowed for pass 3. |
| `humanizerai/agent-skills` | Thin wrapper over a paid hosted API, so it cannot run in the Worker. |

The checklist covers 25 tells in five families: staging, rhythm by rule,
inflation, formatting by rule, and drafting leftovers. Its operating rules are
kept and matter more than the pattern list: keep every supported claim and never
invent a name, number or citation; rewrite the sentence rather than the flagged
phrase; vary sentence length; re-check the five tells that most often survive.

| Pass | Strategy | What changes |
| --- | --- | --- |
| 1 | light | Group A tells and any pattern seen twice. Structure preserved. |
| 2 | aggressive | Every pattern, paragraph shape rebuilt, sentence length varied hard. |
| 3+ | structural | The piece is rebuilt: concrete opening, irregular rhythm, no bold labels, no em dashes, points reordered. |

A pass returning under half the original length, or over double, is discarded and
the input kept, so a bad rewrite cannot destroy the work.

## The scorer: free, in the Worker, unlimited

`src/detector.ts`. The primary scorer is **`ai-text-detector`** (npm,
`John-Salama/ai-text-detector`): MIT, **zero dependencies**, 47 KB. It was
bundled into the real Worker and verified to run under `workerd` with no
polyfills, in about 46ms.

That is the whole cost case. It is CPU inside the Worker already being paid for,
so **a thousand users cost the same as one**. No key, no quota, no per-call
billing. Every hosted free tier fails at this scale:

| Option | Why it cannot work |
| --- | --- |
| Sapling free tier | 250k characters/month is about forty essays. |
| Groq free tier | 1,000 requests/day per organisation, and logprobs are unsupported so curvature methods are out too. |
| Workers AI free tier | 10,000 neurons/day, and the catalogue has **no detector model** at all. |
| SlopTotal, Aletheia, LLaMAudit, ai-detect | All genuinely good, all need Docker, which is the VPS this project rules out. |

**One scorer per run.** Every pass is measured by the same detector, because
comparing pass 1 under one scorer with pass 2 under another compares nothing.
The hosted Copyleaks and Winston calls are kept in `detectHosted` as a dormant
fallback, and would only be reached if the local scorer threw.

### The threshold, and a correction

The first recommendation here was a clean threshold of 0.5. The measurements say
that was wrong, so the number in the code is 0.7.

| Verdict | Score | Sample |
| --- | --- | --- |
| AI | 0.816 | corporate essay |
| AI | 0.752 | triads and em dashes |
| human | 0.671 | student essay, formal but real |
| human | 0.106 | casual and irregular |
| human | 0.755 | plain technical writing |

At 0.5 the scorer calls the 0.671 human essay AI and gets 3 of 5 right. At 0.7 it
gets 4 of 5, the best separator on this data, which is also where the package's
own `isAIGenerated` flag sits. Our own threshold is explicit and tunable rather
than reusing that flag, so the two cannot drift apart silently.

### What this scorer is not

The middle of its range is genuinely unreliable. The plain-technical **human**
sample scored 0.755, which is above a real AI sample at 0.752. On that sample it
returned seven reasons, five of which accused human writing of being AI, and one
of its reasons contradicted another in the same response.

So it is a **formulaic-writing measure, not a verdict**, and the tool result says
so in as many words. The system prompt tells the model never to promise a caller
that anything will pass a checker. Two further reasons that promise would be
false:

- **Detectors disagree with each other** and none is reliably above 80%, whatever
  the vendors claim.
- **Turnitin has no public API.** Its AI detection only exists inside a licensed
  Turnitin Originality account, folded into the Similarity Report. NTU and NUS use
  Turnitin, so the number shown to a student is not the number that decides their
  outcome. That is the category, not a gap in this build.

There is a known bias risk to watch: Liang et al. in *Patterns* found seven major
detectors averaged a **61.3% false positive rate on human-written essays by
non-native English speakers**. This scorer flags plain formal prose, which is the
same failure mode locally. For the essay flow it is harmless because we generated
the text. For a student pasting their own writing it is not, and that needs a
guardrail before this ships to that use case.

### The trap that would have broken the hosted path

`COPYLEAKS_DETECT_AI_TEXT` has `sandbox` defaulting to **true**, and in sandbox it
returns fixed mock output without analysing anything. A loop reading that as real
would "clean" every document on the first pass and always report success. So
sandbox is set false on every call and a response that looks like the mock is
refused. Two more real constraints are handled: `scan_id` must be unique per call
or Copyleaks answers with a duplicate-ID conflict, and `text` has a 255 character
floor.

### The rule that is not negotiable

**A missing score never becomes 0.** Zero is what ends the loop and tells the
caller the work is clean. An unreadable, sandboxed or failed response returns
null, and the loop reports the text as **unverified**. A fabricated zero would
mark unchecked text as clean, silently, on every call.

## Tests

`test/humanize.test.ts`, run with `npm test` (esbuild bundle, then node). 22
cases. They cover the local scorer's threshold in both directions, that the free
path answers without touching any connection, that a sandboxed or unparseable
hosted body is never scored, that a genuine zero still counts as clean, and that
text under the floor is reported unscoreable rather than guessed at.

## Files

| File | Change |
| --- | --- |
| `src/humanize.ts` | new. Checklist prompts and the escalation ladder. |
| `src/detector.ts` | new. Free local scorer first, hosted fallback, honest scoring. |
| `src/harness.ts` | `humanize_and_check` built-in tool, the loop, progress lines, step budget 6 to 9, and the returned document exempted from output truncation so the write-back is verbatim. |
| `test/humanize.test.ts`, `test/run.sh` | new. |
| `package.json` | adds `ai-text-detector` and `npm test`. |

`wrangler deploy --dry-run` passes: 2.4 MiB, 460 KiB gzipped, and the scorer is
present in the bundle.

## Still needed

1. The **`ailobang.com` Cloudflare token**, for any deploy. Unchanged.
2. Nothing else. The free path needs no connection and no key.
