/**
 * AI-detector call.
 *
 * The free path runs entirely inside the Worker: `ai-text-detector` is MIT,
 * has zero dependencies, bundles into workerd with no polyfills, and costs
 * nothing per call, so a thousand users cost the same as one. That matters
 * because no hosted free tier survives real volume. Sapling's free allowance is
 * about forty essays a month, Groq's free tier is 1,000 requests per day per
 * organisation, and Workers AI has no detector model in its catalogue at all.
 *
 * ONE SCORER PER RUN. Every pass of the loop is measured by the same detector,
 * because comparing pass 1 under one scorer with pass 2 under another compares
 * nothing. The local scorer therefore wins whenever it can produce a score, and
 * the hosted detectors are only a fallback for when it cannot.
 *
 * The hosted path is kept because it costs nothing to keep: if a Copyleaks or
 * Winston key is ever connected, `detectHosted` still works and can be promoted.
 *
 * THE HONESTY RULE, which is the reason this file is careful. A missing score
 * never becomes zero. Zero means "the detector says human", it is what ends the
 * loop, and it is what the caller is told. A fabricated zero would mark
 * unchecked text as clean, silently, on every call. Anything unscored returns
 * null and the loop reports the text as unverified.
 */

import { detectAIText } from "ai-text-detector";

/** Copyleaks refuses anything shorter than this, and short text scores badly everywhere. */
const MIN_SCOREABLE_CHARS = 255;

/**
 * Where the local scorer is asked to call text human.
 *
 * My first instinct was 0.5, and the measurements say that was wrong. Five
 * samples of known provenance, scored by the package:
 *
 *   AI     0.816   corporate essay
 *   AI     0.752   triads and em dashes
 *   human  0.671   student essay, formal but real
 *   human  0.106   casual and irregular
 *   human  0.755   plain technical writing
 *
 * A threshold of 0.5 calls the 0.671 human essay AI and scores 3 of 5. A
 * threshold of 0.7 scores 4 of 5 and is the best separator on this data, which
 * is also what the package's own `isAIGenerated` flag uses. The middle of the
 * range is genuinely unreliable: the plain-technical human sample lands above a
 * real AI sample, so this remains a formulaic-writing score, not a verdict, and
 * no caller should hear a percentage as though a person had judged the text.
 */
const LOCAL_CLEAN_THRESHOLD = 0.7;

export type DetectorSource = "local" | "copyleaks" | "winston" | "none";

export interface DetectResult {
  /** Percentage of text judged AI-written, 0-100. null when no honest reading was possible. */
  aiScore: number | null;
  /** Which detector produced it. */
  source: DetectorSource;
  /** Whether the scoring detector considers the text human. */
  clean: boolean;
  /** Why there is no score, when there is not one. */
  unavailable?: string;
  /** The local scorer explains itself; the hosted ones do not. */
  reasons?: string[];
}

type McpCaller = (name: string, args: Record<string, unknown>) => Promise<string>;

export function isScoreable(text: string): boolean {
  return text.trim().length >= MIN_SCOREABLE_CHARS;
}

/**
 * The free path. Runs in-process, so it cannot fail for want of a connection,
 * a quota or a key.
 */
export function detectLocally(text: string): DetectResult {
  if (!isScoreable(text)) {
    return { aiScore: null, source: "none", clean: false, unavailable: tooShort(text) };
  }

  try {
    const result = detectAIText(text);
    if (typeof result?.score !== "number" || !Number.isFinite(result.score)) {
      return { aiScore: null, source: "none", clean: false, unavailable: "the local scorer returned no score" };
    }

    // The package reports 0-1. The rest of the app thinks in percentages.
    const score = Math.max(0, Math.min(1, result.score));
    return {
      aiScore: Math.round(score * 1000) / 10,
      source: "local",
      // Deliberately not result.isAIGenerated: our own threshold is explicit and
      // tunable, and the two must not drift apart silently.
      clean: score < LOCAL_CLEAN_THRESHOLD,
      reasons: Array.isArray(result.reasons) ? result.reasons : undefined,
    };
  } catch (error) {
    return { aiScore: null, source: "none", clean: false, unavailable: errorText(error) };
  }
}

/**
 * The hosted path, tried in order. Only used when the local scorer cannot answer.
 *
 * THE TRAP. `COPYLEAKS_DETECT_AI_TEXT` has `sandbox` defaulting to **true**, and
 * in sandbox it returns fixed mock output without analysing the text. A loop
 * reading a mock score as real would "clean" every document instantly and always
 * report success. So sandbox is set false on every call and a response that looks
 * like the mock is rejected rather than scored. Two more real constraints are
 * handled: `scan_id` must be unique per call or Copyleaks answers with a
 * duplicate-ID conflict, and `text` has a 255 character floor.
 */
export async function detectHosted(mcpCall: McpCaller, text: string): Promise<DetectResult> {
  if (!isScoreable(text)) {
    return { aiScore: null, source: "none", clean: false, unavailable: tooShort(text) };
  }

  const copyleaks = await tryCopyleaks(mcpCall, text);
  if (copyleaks.aiScore !== null) return copyleaks;

  const winston = await tryWinston(mcpCall, text);
  if (winston.aiScore !== null) return winston;

  return {
    aiScore: null,
    source: "none",
    clean: false,
    unavailable: `no detector returned a usable score (copyleaks: ${copyleaks.unavailable}; winston: ${winston.unavailable})`,
  };
}

/**
 * The chain the loop actually calls. The free local scorer answers first; the
 * hosted detectors only get a turn if it cannot.
 */
export async function detectAi(mcpCall: McpCaller, text: string): Promise<DetectResult> {
  const local = detectLocally(text);
  if (local.aiScore !== null) return local;
  return detectHosted(mcpCall, text);
}

async function tryCopyleaks(mcpCall: McpCaller, text: string): Promise<DetectResult> {
  try {
    const raw = await mcpCall("COPYLEAKS_DETECT_AI_TEXT", {
      text,
      // A fresh id every call; Copyleaks rejects a reused one as a duplicate.
      scan_id: `ailobang-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Never leave this at its default; the default is mock output.
      sandbox: false,
      explain: false,
      language: "en",
    });

    if (looksLikeMock(raw)) {
      return { aiScore: null, source: "none", clean: false, unavailable: "copyleaks returned its sandbox mock" };
    }

    const score = extractPercent(raw, ["ai", "aiScore", "ai_score", "aiProbability", "summary.ai"]);
    if (score === null) {
      return { aiScore: null, source: "none", clean: false, unavailable: "no percentage found in the response" };
    }
    return { aiScore: score, source: "copyleaks", clean: score === 0 };
  } catch (error) {
    return { aiScore: null, source: "none", clean: false, unavailable: errorText(error) };
  }
}

async function tryWinston(mcpCall: McpCaller, text: string): Promise<DetectResult> {
  try {
    const raw = await mcpCall("WINSTON_AI_AI_TEXT_DETECTION", { text });

    const score = extractPercent(raw, ["score", "aiScore", "ai_score", "aiProbability", "percentage"]);
    if (score === null) {
      return { aiScore: null, source: "none", clean: false, unavailable: "no percentage found in the response" };
    }
    return { aiScore: score, source: "winston", clean: score === 0 };
  } catch (error) {
    return { aiScore: null, source: "none", clean: false, unavailable: errorText(error) };
  }
}

/** Copyleaks' sandbox returns a fixed body; recognising it stops a fake pass. */
export function looksLikeMock(raw: string): boolean {
  return /sandbox|mock output|integration testing|fixed copyleaks/i.test(raw);
}

/**
 * Hunts a percentage under any of the given keys, at the top level or one level
 * down, and accepts either 0-1 or 0-100 scale. Returns null when nothing suitable
 * is present, which the caller must treat as "unknown", never as zero.
 */
export function extractPercent(raw: string, keys: string[]): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const flat = flatten(parsed);
  for (const key of keys) {
    const leaf = key.split(".").pop() as string;
    for (const [path, value] of Object.entries(flat)) {
      if (!path.toLowerCase().endsWith(leaf.toLowerCase())) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      // Copyleaks reports 0-1 in places and 0-100 in others.
      const percent = value >= 0 && value <= 1 ? value * 100 : value;
      if (percent < 0 || percent > 100) continue;
      return Math.round(percent * 10) / 10;
    }
  }
  return null;
}

function flatten(value: unknown, prefix = ""): Record<string, unknown> {
  if (value === null || typeof value !== "object") return { [prefix]: value };
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object") Object.assign(out, flatten(child, path));
    else out[path] = child;
  }
  return out;
}

function tooShort(text: string): string {
  return `the text is too short to score (${text.trim().length} characters, ${MIN_SCOREABLE_CHARS} needed)`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
