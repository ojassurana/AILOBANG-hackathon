/**
 * Jev, TypeSafe's decision model, through OpenRouter's Decisions API.
 *
 * Jev does not write text. It takes a `state` and typed `questions` and gives
 * back typed answers with probabilities: a `choice` picks one option and says
 * how concentrated the distribution was, a `noul` gives the probability that a
 * statement is true. That is what routes memory: whether a conversation
 * changes anything, which branch to read or write, whether two memories are
 * the same thing. Skill search itself is Vector Search. Code owns every step
 * after the answer.
 */

const DECISIONS_API = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";
/** A memory decision that takes longer than this is not worth waiting on in a call. */
const TIMEOUT_MS = 10000;

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export interface JevResult {
  answers: Record<string, JevAnswer>;
  costUsd: number;
}

export type JevClient = (state: unknown, questions: Record<string, JevQuestion>) => Promise<JevResult>;

/** A Jev client bound to one OpenRouter key. */
export function jevClient(apiKey: string, fetchImpl: typeof fetch = fetch): JevClient {
  return (state, questions) => decide(apiKey, state, questions, fetchImpl);
}

export async function decide(
  apiKey: string,
  state: unknown,
  questions: Record<string, JevQuestion>,
  fetchImpl: typeof fetch = fetch,
): Promise<JevResult> {
  const response = await fetchImpl(DECISIONS_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://ailobang.com",
      "X-Title": "Ailobang memory",
    },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`jev ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    answers?: Record<string, Record<string, unknown>>;
    usage?: { cost?: number };
  };
  return { answers: parseAnswers(payload.answers ?? {}), costUsd: Number(payload.usage?.cost ?? 0) };
}

/** Keeps only answers of a shape the callers can act on. */
export function parseAnswers(raw: Record<string, Record<string, unknown>>): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, answer] of Object.entries(raw)) {
    if (!answer || typeof answer !== "object") continue;
    if (answer.type === "choice" && typeof answer.choice === "string") {
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        confidence: clamp(Number(answer.confidence ?? 0)),
        probabilities: numberMap(answer.probabilities),
      };
    } else if (answer.type === "noul" && typeof answer.noul === "number") {
      answers[id] = { type: "noul", noul: clamp(answer.noul) };
    }
  }
  return answers;
}

export function choiceOf(
  answers: Record<string, JevAnswer>,
  id: string,
): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  const answer = answers[id];
  return answer?.type === "choice" ? answer : null;
}

export function noulOf(answers: Record<string, JevAnswer>, id: string): number | null {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : null;
}

function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const [key, probability] of Object.entries(value as Record<string, unknown>)) {
      if (typeof probability === "number") out[key] = clamp(probability);
    }
  }
  return out;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
