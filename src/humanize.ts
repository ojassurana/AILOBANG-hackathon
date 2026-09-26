/**
 * Humanizer pass, built on blader/humanizer (MIT, 50k stars), the highest-usage
 * humanizer skill in the skills.sh registry.
 *
 * The skill is a numbered checklist of 25 AI writing tells in five families:
 * staging, rhythm by rule, inflation, formatting by rule, and drafting leftovers.
 * Its operating rules matter as much as the pattern list, so they are carried
 * over verbatim in spirit:
 *
 *   - keep every supported claim; never add a name, number, date or citation
 *     that was not in the source
 *   - rewrite the sentence rather than patching flagged phrases
 *   - vary sentence length; real writing alternates short and long
 *   - re-check the five tells that most often survive a rewrite: a not-X-but-Y
 *     contrast, a one-line closer, a dash, a triad, a bold label
 *
 * Escalation exists because one pass does not always clear a detector. Each
 * attempt is a strictly stronger rewrite, and the detector decides whether to
 * stop, not this module.
 */

import { chatWithTools, type ChatMessage } from "./deepseek";

const PATTERNS = `## The 25 tells, strongest first

A. Staging instead of stating (act on one sighting)
1. Not X but Y — "not just X, but Y", "it's not X, it's Y", the reversed form, a clipped negative tail (", no guessing").
2. One-line closers and dramatic fragments — a one-sentence paragraph restating the one above, "That is the real win.", "Let that sink in.", a row of fragments, EXPENSIVE.ALL.CAPS pairs.
3. Sayings that sound deep — a platitude closing a paragraph that adds no fact.
4. Staged run-up before the point — "In today's world...", "When it comes to...", throat-clearing before the sentence gets to work.
5. Arguing with no one — refuting an objection nobody raised.

B. Rhythm by rule
6. Forced triads — three parallel examples where one or two would do.
7. Repeated sentence openings — consecutive sentences starting the same way.
8. Dashes as the universal connector — an em dash wherever a comma, colon or full stop belongs.
9. Stacked qualifiers — very, really, quite, notably, particularly, arguably piled up.
10. Hyphenated pairs everywhere — a hyphenated compound wherever a plain word exists.
11. Passive voice and missing subjects — no actor, "it should be noted".

C. Inflation and borrowed authority
12. Overused AI words — delve, leverage, robust, seamless, landscape, tapestry, testament, crucial, pivotal, navigate, realm, underscore, foster, meticulous.
13. Inflated significance — an ordinary fact dressed as pivotal, transformative or a watershed.
14. Vague connection or association — linked to, associated with, speaks to, in the realm of, when nobody did the linking.
15. Shallow -ing riders — a trailing participle pretending to explain: ", highlighting the importance of...".
16. Sales language — unlock, elevate, supercharge, game-changing, take it to the next level.
17. Borrowed authority — "studies show", "experts agree", "it is widely believed" with no source.
18. Avoiding is, are and has — "serves as", "functions as", "stands as", "represents" where "is" is the plain word.

D. Formatting by rule
19. Bold as decoration — bold on every definition, label or key term rather than where emphasis is earned.
20. Decorative headings — a heading for every two sentences, headings that restate their content.
21. Curly quotation marks and typographic tells where the writer would use straight ones.

E. Leftovers from the chat and the draft
22. Chatbot residue — "Certainly!", "Great question", "I hope this helps", "Let me know if".
23. Knowledge-limit disclaimers — "as of my last update", hedged guesses about cutoffs.
24. A heading repeated in the first sentence beneath it.
25. Writing about the previous version — "in this revised version", "I have changed".`;

/** The five tells that survive a rewrite most often, so every pass re-checks them. */
const SURVIVORS = `Before returning, search once more for the five tells that most often survive:
a not-X-but-Y contrast, a one-line closer, a dash, a forced triad, a decorative bold label.`;

const BASE_RULES = `You are rewriting text so it reads like a specific human wrote it. Work as an editor, not a paraphraser.

Hard rules, in order of importance:
- Keep every supported claim. Do not add a fact, name, number, date, quote or citation that is not in the source text. Adding one is a failure, not a flourish.
- Rewrite the sentence, not the flagged phrase. If a sentence is still awkward, rewrite the paragraph around its main point.
- Fix the structure, because structure carries the tell. Word swaps alone change nothing.
- Keep the writer's meaning, stance and any stated uncertainty.
- Return the rewritten text only. No preamble, no commentary, no markdown fences, no explanation of what you changed.`;

/** Attempt 1. Clear the strongest tells, leave the writer's structure standing. */
const LIGHT = `${BASE_RULES}

${PATTERNS}

Scope for this pass: fix the group A tells wherever they appear and any other pattern you find more than once. Leave standalone weak tells alone if the sentence already reads naturally. Preserve the paragraph structure.

${SURVIVORS}`;

/** Attempt 2. Every pattern, and restructure where the shape itself is the tell. */
const AGGRESSIVE = `${BASE_RULES}

${PATTERNS}

Scope for this pass: this text has already been through one pass and still reads as machine-written, so the easy fixes are gone. Work every pattern in every group. Rebuild paragraph shape wherever the shape is itself a tell — merge paragraphs that stage a point, split paragraphs doing two jobs, and vary sentence length hard: put a short sentence next to a long one deliberately. Prefer the plainest available word.

Specifically hunt what survived the first pass: em dashes, forced triads, any not-X-but-Y, inflated significance, and -ing riders.

${SURVIVORS}`;

/** Attempt 3+. The structural rewrite, which is the second, different strategy. */
const STRUCTURAL = `${BASE_RULES}

${PATTERNS}

Scope for this pass: two passes have failed, so the problem is the shape of the writing, not its wording. Rebuild it.
- Write the opening sentence as a concrete statement of a fact or a position. No setup, no framing, no "In today's...".
- Give the piece an irregular rhythm on purpose: mix very short sentences with long ones, and let some paragraphs be two sentences.
- Allow the register a person actually uses when writing about this: contractions, a direct address to the reader, an aside. Keep it appropriate to the genre, and keep any academic register the source establishes.
- Remove every bold label, every decorative heading, and every em dash.
- If the piece still reads like an essay written to a template, break the template: reorder points so the strongest comes first.

${SURVIVORS}`;

export interface HumanizeAttempt {
  pass: number;
  strategy: "light" | "aggressive" | "structural";
}

/** How many passes before the caller gives up, and what each one does. */
export function strategyFor(pass: number): HumanizeAttempt {
  if (pass <= 1) return { pass, strategy: "light" };
  if (pass === 2) return { pass, strategy: "aggressive" };
  return { pass, strategy: "structural" };
}

function promptFor(pass: number): string {
  const { strategy } = strategyFor(pass);
  if (strategy === "light") return LIGHT;
  if (strategy === "aggressive") return AGGRESSIVE;
  return STRUCTURAL;
}

/**
 * One humanizing pass. Returns the rewritten text, or the input unchanged if the
 * model returned something obviously broken, so a bad pass cannot destroy the work.
 */
export async function humanizePass(
  apiKey: string,
  text: string,
  pass: number,
  userId: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: promptFor(pass) },
    { role: "user", content: text },
  ];

  // One tool round is all this needs; the empty tool list keeps it a plain completion.
  const reply = await chatWithTools(apiKey, messages, [], userId);
  const rewritten = (reply.content ?? "").trim();

  if (!rewritten) return text;
  // A rewrite that lost most of the text, or ballooned, is a bad pass rather than a
  // better one. Keeping the input makes the caller retry instead of writing junk.
  const ratio = rewritten.length / Math.max(text.length, 1);
  if (ratio < 0.5 || ratio > 2) return text;

  return stripFences(rewritten);
}

/** Models love a code fence even when told not to. */
function stripFences(value: string): string {
  const fenced = value.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return (fenced ? fenced[1] : value).trim();
}
