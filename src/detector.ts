/**
 * AI-detector call, through the caller's own Composio connections.
 *
 * Two detectors, tried in order: Copyleaks' AI Text Detector, then Winston AI.
 * Both are API-key toolkits, so they need a platform connection in the AiLobang
 * Composio project rather than one per user.
 *
 * THE TRAP, and the reason this file is defensive. `COPYLEAKS_DETECT_AI_TEXT`
 * has `sandbox` defaulting to **true**, and in sandbox it returns fixed mock
 * output without analysing the text. A loop that reads a mock score as real would
 * "clean" every document instantly and always report success. So:
 *
 *   - sandbox is set to false explicitly on every call
 *   - a response that looks like the mock is rejected, never scored
 *   - an unparseable response returns null, which the loop treats as failure
 *
 * Never default a missing score to 0. Zero means "the detector says human" and a
 * fabricated zero would silently end the loop on text nobody checked.
 *
 * Two more real constraints, both handled here:
 *   - `scan_id` must be unique per call, or Copyleaks answers with a duplicate-ID
 *     conflict. Every call gets a fresh id.
 *   - `text` must be at least 255 characters. Shorter text is reported as
 *     unscoreable rather than sent and failed.
 */

/** Copyleaks refuses anything shorter than this, and scoring it is meaningless. */
const MIN_SCOREABLE_CHARS = 255;

export interface DetectResult {
  /** Percentage of text judged AI-written. null when no honest reading was possible. */
  aiScore: number | null;
  /** Which detector produced it. */
  source: "copyleaks" | "winston" | "none";
  /** Why there is no score, when there is not one. */
  unavailable?: string;
}

type McpCaller = (name: string, args: Record<string, unknown>) => Promise<string>;

export function isScoreable(text: string): boolean {
  return text.trim().length >= MIN_SCOREABLE_CHARS;
}

/**
 * Runs one detector and reads a percentage out of it. Returns null rather than
 * guessing when the response cannot be trusted.
 */
export async function detectAi(mcpCall: McpCaller, text: string): Promise<DetectResult> {
  if (!isScoreable(text)) {
    return {
      aiScore: null,
      source: "none",
      unavailable: `the text is too short to score (${text.trim().length} characters, ${MIN_SCOREABLE_CHARS} needed)`,
    };
  }

  const copyleaks = await tryCopyleaks(mcpCall, text);
  if (copyleaks.aiScore !== null) return copyleaks;

  const winston = await tryWinston(mcpCall, text);
  if (winston.aiScore !== null) return winston;

  return {
    aiScore: null,
    source: "none",
    unavailable: `no detector returned a usable score (copyleaks: ${copyleaks.unavailable}; winston: ${winston.unavailable})`,
  };
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
      return { aiScore: null, source: "none", unavailable: "copyleaks returned its sandbox mock" };
    }

    const score = extractPercent(raw, ["ai", "aiScore", "ai_score", "aiProbability", "summary.ai"]);
    if (score === null) {
      return { aiScore: null, source: "none", unavailable: "no percentage found in the response" };
    }
    return { aiScore: score, source: "copyleaks" };
  } catch (error) {
    return { aiScore: null, source: "none", unavailable: errorText(error) };
  }
}

async function tryWinston(mcpCall: McpCaller, text: string): Promise<DetectResult> {
  try {
    const raw = await mcpCall("WINSTON_AI_AI_TEXT_DETECTION", { text });

    const score = extractPercent(raw, ["score", "aiScore", "ai_score", "aiProbability", "percentage"]);
    if (score === null) {
      return { aiScore: null, source: "none", unavailable: "no percentage found in the response" };
    }
    return { aiScore: score, source: "winston" };
  } catch (error) {
    return { aiScore: null, source: "none", unavailable: errorText(error) };
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
