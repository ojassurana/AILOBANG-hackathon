# Humanize-and-check: writing a document that does not read as AI

Status: **built and unit-tested.** Not deployed. Needs a detector connection and a
Cloudflare token to go live.

## The flow the caller hears

1. The caller asks for an essay or report.
2. The agent writes it to Google Docs first, so the document is open and visible
   while the rest happens.
3. The agent calls `humanize_and_check`, and the caller hears
   **"Humanizing it now."**
4. The rewritten text goes to an AI detector, and the caller hears
   **"Running it past the AI detector."**
5. If the detector still reports AI-written text, the caller hears
   **"It still reads as AI-written, so I am rewriting it harder."** and the loop
   repeats at a stronger setting.
6. At 0 percent the caller hears **"It reads as human-written now. Finished."**
7. The final text is written back into the same document.

Each of those lines is emitted through the existing `onProgress` callback in
`src/harness.ts`, which is the same channel that already produces "Fetching that
now." during a call, so GPT-Live speaks them with no new plumbing.

## The humanizer

`src/humanize.ts`, built on **blader/humanizer** from the skills.sh registry:
MIT, about 50k stars, and the highest-usage humanizer there. It was chosen over
the alternatives because it is a structured checklist rather than prose advice.

Two others were considered and rejected as the primary:

| Skill | Why not the default |
| --- | --- |
| `aboudjem/humanizer-skill` | 55 patterns and a 0-100 self-score, but the score is its own opinion, not a detector. Scoring yourself is circular when the goal is to satisfy an outside checker. Useful as an escalation style. |
| `humanizerai/agent-skills` | Thin wrapper over a paid hosted API, so it cannot run in the Worker. |

The skill carries 25 tells in five families: staging, rhythm by rule, inflation,
formatting by rule, and drafting leftovers. Its operating rules are kept, and
they matter more than the pattern list:

- keep every supported claim, and never invent a name, number, date or citation
- rewrite the sentence rather than patching the flagged phrase
- vary sentence length, because real writing alternates short and long
- re-check the five tells that most often survive a rewrite

## Escalation

`strategyFor(pass)` in `src/humanize.ts`. Each pass is a strictly stronger
rewrite, and the detector decides when to stop.

| Pass | Strategy | What changes |
| --- | --- | --- |
| 1 | light | Group A tells and any pattern seen twice. Structure preserved. |
| 2 | aggressive | Every pattern, paragraph shape rebuilt, sentence length varied hard. |
| 3+ | structural | The piece is rebuilt: concrete opening, irregular rhythm, no bold labels, no em dashes, points reordered. |

A pass that returns under half the original length, or more than double, is
discarded and the input kept, so a bad rewrite cannot destroy the work.

## The detector, and the trap that would have broken this

`src/detector.ts` tries **Copyleaks** (`COPYLEAKS_DETECT_AI_TEXT`) then
**Winston AI** (`WINSTON_AI_AI_TEXT_DETECTION`). Three real constraints, all of
which would have failed silently:

1. **`sandbox` defaults to `true`**, and in sandbox Copyleaks returns fixed mock
   output without analysing anything. A loop reading that mock as real would
   "clean" every document on the first pass and always report success. The
   worker sets `sandbox: false` on every call and refuses any response that
   looks like the mock.
2. **`scan_id` must be unique per call**, or Copyleaks answers with a duplicate-ID
   conflict. Every call generates a fresh one, so pass 2 does not fail.
3. **`text` has a 255 character minimum.** Shorter text is reported as
   unscoreable instead of being sent and failing.

And the rule that matters most: **a missing score never becomes 0.** Zero is what
ends the loop and tells the caller the work is verified, so an unreadable,
sandboxed or failed response returns `null` and the loop reports the text as
**unverified** rather than clean. A fabricated zero here would mark unchecked
text as human-written, silently, on every single call.

Both detectors are API-key toolkits, so they need a **platform-level connection
in the AiLobang Composio project**, not one per user.

## Honest limits

No humanizer can guarantee a given detector returns 0. Detectors are
probabilistic, they disagree with each other, and their accuracy on paraphrased
text is contested. What is built here is the loop and the honest reporting: it
escalates until a real detector says human, and if it never does, or nothing
could score the text, it says so instead of claiming success. The attempt cap is
4 so a call cannot spin.

There is a second-order risk worth naming: rewriting text specifically to defeat
a detector is a different goal from writing well. Passes 2 and 3 make the prose
more direct and less formulaic, which is the durable improvement, but a document
optimised only against one detector may read oddly to a human marker.

## Tests

`test/humanize.test.ts`, run with `npm test` (esbuild bundle, then node). 16
cases, focused on the loop's stop condition: a sandboxed body, an unparseable
body, an out-of-range percentage, a failed detector and a sub-255-character
input all have to come back as unscored rather than zero, a genuine 0 has to
survive as 0, a broken Copyleaks has to fall through to Winston, and every call
has to carry a fresh `scan_id` and an explicit `sandbox: false`.

## Files

| File | Change |
| --- | --- |
| `src/humanize.ts` | new. The checklist prompts and the escalation ladder. |
| `src/detector.ts` | new. Detector calls, mock rejection, honest scoring. |
| `src/harness.ts` | `humanize_and_check` built-in tool, loop, progress lines, step budget 6 to 9, and the returned document exempted from tool-output truncation so the write-back is verbatim. |
| `test/humanize.test.ts`, `test/run.sh` | new. |
| `package.json` | adds `npm test`. |

## Still needed

1. A **Copyleaks or Winston AI** connection in the AiLobang Composio project.
   Until one exists the loop reports every document as unverified, which is the
   intended failure mode rather than a bug.
2. The **`ailobang.com` Cloudflare token**, unchanged, for any deploy.
