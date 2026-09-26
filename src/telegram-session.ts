/**
 * The Telegram login state machine and the rules around sending.
 *
 * Nothing here imports `teleproto` or touches a socket. That is deliberate: the
 * decisions that are expensive to get wrong — how many wrong codes to accept,
 * which Telegram error means "ask for the password" and which means "this
 * session is dead", how fast we are allowed to send — are all pure functions of
 * what Telegram said and what we stored. Keeping them out of the Durable Object
 * means they can be tested without a phone number, a network, or a real account.
 *
 * The Durable Object owns storage and sockets; this file owns judgement.
 */

/** Where a login has got to. */
export type TelegramPhase = "idle" | "code" | "password" | "connected" | "error";

export interface TelegramLoginState {
  phase: TelegramPhase;
  /** The number as the user typed it, kept so a retry does not ask again. */
  phone: string | null;
  /**
   * Required by `auth.SignIn` alongside the code, and the reason a wrong code
   * does not start over: the hash is still the one the code was sent against.
   */
  phoneCodeHash: string | null;
  /** Whether the code went to another Telegram app rather than by SMS. */
  codeViaApp: boolean;
  codeSentAt: number | null;
  /** Wrong codes since the last code was sent. */
  attempts: number;
  /** What to tell the user about the last failure. */
  error: string | null;
  /** Epoch ms before which retrying cannot succeed (flood waits). */
  retryAt: number | null;
}

/**
 * Three wrong codes and the code is dead, because Telegram invalidates it after
 * a few tries anyway and continuing just burns the flood allowance.
 */
export const MAX_CODE_ATTEMPTS = 3;

/** A code older than this is very likely rejected; Telegram expires them too. */
export const CODE_TTL_MS = 10 * 60 * 1000;

export function idleLoginState(): TelegramLoginState {
  return {
    phase: "idle",
    phone: null,
    phoneCodeHash: null,
    codeViaApp: false,
    codeSentAt: null,
    attempts: 0,
    error: null,
    retryAt: null,
  };
}

export function codeSent(
  phone: string,
  phoneCodeHash: string,
  codeViaApp: boolean,
  now: number,
): TelegramLoginState {
  return {
    phase: "code",
    phone,
    phoneCodeHash,
    codeViaApp,
    codeSentAt: now,
    attempts: 0,
    error: null,
    retryAt: null,
  };
}

/**
 * A wrong code. The `phoneCodeHash` and the phone survive, so the user retries
 * against the same code; only running out of attempts drops back to idle, where
 * a fresh code has to be requested.
 */
export function codeRejected(state: TelegramLoginState, message: string): TelegramLoginState {
  const attempts = state.attempts + 1;
  if (attempts >= MAX_CODE_ATTEMPTS) {
    return {
      ...idleLoginState(),
      phone: state.phone,
      error: message,
    };
  }
  return { ...state, attempts, error: message };
}

/** Telegram will accept the code, but the account has a cloud password. */
export function passwordNeeded(state: TelegramLoginState): TelegramLoginState {
  return { ...state, phase: "password", error: null };
}

/**
 * A finished login.
 *
 * The phone number survives it, unlike the rest of the login: it is the only
 * name we have for an account with no @username, and the connected row and the
 * step screen both identify the session by it. Clearing it here is what made
 * both say "Connected" followed by nothing.
 */
export function loginConnected(now: number, phone: string | null = null): TelegramLoginState {
  return { ...idleLoginState(), phase: "connected", phone, codeSentAt: now };
}

/**
 * A failure during login, recorded from the state it failed out of.
 *
 * The phone number and the code hash survive. Most failures here are transient
 * — a dropped connection, a flood wait — and discarding the hash would force a
 * fresh code on each one, spending the flood allowance for nothing. The error
 * is what the row shows; the hash is what makes retrying cheap.
 */
export function loginFailed(
  state: TelegramLoginState,
  message: string,
  retryAt: number | null = null,
): TelegramLoginState {
  return {
    ...idleLoginState(),
    phase: "error",
    error: message,
    retryAt,
    phone: state.phone,
    phoneCodeHash: state.phoneCodeHash,
    codeViaApp: state.codeViaApp,
    codeSentAt: state.codeSentAt,
  };
}

/** Back to the start, keeping nothing but the phone number the user typed. */
export function restartLogin(state: TelegramLoginState): TelegramLoginState {
  return { ...idleLoginState(), phone: state.phone };
}

/* --------------------------------------------------------- error classification */

/**
 * What a Telegram error means for us. The distinction that matters most is
 * between an error the user can fix by typing something else and one where the
 * stored session is gone and the row has to go back to Not connected.
 */
export type TelegramErrorKind =
  | "bad_code"
  | "bad_phone"
  | "password"
  | "password_wrong"
  | "flood"
  | "session_dead"
  | "blocked"
  | "privacy"
  | "stale_peer"
  | "duplicate_key"
  /** Our own setup is wrong. Nothing the user can do, and it must not read as their fault. */
  | "config"
  | "unknown";

/** Telegram's error names, grouped by the response they demand. */
const ERROR_NAMES: Record<string, TelegramErrorKind> = {
  PHONE_CODE_INVALID: "bad_code",
  PHONE_CODE_EMPTY: "bad_code",
  PHONE_CODE_EXPIRED: "bad_code",
  PHONE_CODE_HASH_EMPTY: "bad_code",
  PHONE_HASH_EXPIRED: "bad_code",
  AUTH_RESTART: "bad_code",

  PHONE_NUMBER_INVALID: "bad_phone",
  PHONE_NUMBER_BANNED: "bad_phone",
  PHONE_NUMBER_FLOOD: "bad_phone",

  SESSION_PASSWORD_NEEDED: "password",
  PASSWORD_HASH_INVALID: "password_wrong",
  SRP_ID_INVALID: "password_wrong",
  SRP_A_INVALID: "password_wrong",

  FLOOD_WAIT: "flood",
  SLOWMODE_WAIT: "flood",
  // `FloodError` sets the bare name "FLOOD" and keeps the seconds in a field.
  FLOOD: "flood",
  FLOOD_PREMIUM_WAIT: "flood",
  FLOOD_TEST_PHONE_WAIT: "flood",

  API_ID_INVALID: "config",
  API_ID_PUBLISHED_FLOOD: "config",
  CONNECTION_API_ID_INVALID: "config",

  SESSION_REVOKED: "session_dead",
  SESSION_EXPIRED: "session_dead",
  AUTH_KEY_UNREGISTERED: "session_dead",
  AUTH_KEY_INVALID: "session_dead",
  USER_DEACTIVATED_BAN: "session_dead",
  USER_DEACTIVATED: "session_dead",

  AUTH_KEY_DUPLICATED: "duplicate_key",

  USER_IS_BLOCKED: "blocked",
  YOU_BLOCKED_USER: "blocked",
  PEER_FLOOD: "blocked",

  PRIVACY_PREMIUM_REQUIRED: "privacy",
  PEER_ID_INVALID: "stale_peer",
};

export interface ClassifiedError {
  kind: TelegramErrorKind;
  /** The Telegram name, kept for logs; never spoken to the user. */
  name: string;
  /** Safe, plain, and true for the user or the model to say out loud. */
  message: string;
  /** Seconds to wait, when Telegram said so. */
  seconds: number | null;
}

/**
 * Where the name really is, when the thrown object will not say it.
 *
 * Both fields exist because the library is inconsistent: a specific error class
 * overrides `errorMessage` with the machine name, while the generic `RPCError`
 * leaves a human sentence there and puts the machine name at the front of
 * `message`. Neither is reliable on its own.
 */
export interface TelegramErrorShape {
  /** Telegram's machine name, when the thrower knows it. */
  name?: string | null;
  /** Seconds to wait, when the library typed the number instead of folding it into the name. */
  seconds?: number | null;
}

const BARE_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The machine name off `errorMessage`, but only when it is a bare name.
 *
 * Accepting it unconditionally is what made an invalid `api_id` classify as the
 * unknown `"API"`: the human message there reads `API ID invalid. (caused by
 * auth.SendCode)`, and its first word is indistinguishable from an error name.
 */
function readName(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = (raw as { errorMessage?: unknown }).errorMessage;
  if (typeof candidate !== "string") return null;
  return BARE_NAME.test(candidate.trim()) ? candidate.trim() : null;
}

/**
 * The name at the front of a message, past the numeric status the base class
 * prefixes to unknown errors (`420: FLOOD_WAIT_17 (caused by ...)`).
 */
const LEADING_NAME = /^(?:\d+:\s*)?([A-Z][A-Z0-9_]+)/;

/**
 * Reads Telegram's error name out of whatever the library threw.
 *
 * Preference order is deliberate: an explicitly supplied name wins, then the
 * bare name on `errorMessage`, and only then the leading token of the message.
 * The trailing `_17` of `FLOOD_WAIT_17` is stripped, because the number belongs
 * in `seconds`, not in the key that picks the response.
 */
export function classifyTelegramError(
  raw: unknown,
  shape: TelegramErrorShape = {},
): ClassifiedError {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  const name = (
    shape.name ??
    readName(raw) ??
    LEADING_NAME.exec(text.trim())?.[1] ??
    "UNKNOWN"
  ).replace(/_\d+$/, "");

  const fromName = /FLOOD_WAIT_(\d+)/.exec(text)?.[1];
  const seconds = typeof shape.seconds === "number" ? shape.seconds : fromName ? Number(fromName) : null;

  const kind = ERROR_NAMES[name] ?? "unknown";

  return { kind, name, message: describe(kind, name, seconds), seconds };
}

function describe(kind: TelegramErrorKind, name: string, seconds: number | null): string {
  switch (kind) {
    case "bad_code":
      return "That code wasn't right. Check the message from Telegram and try again.";
    case "bad_phone":
      return "Telegram wouldn't accept that number. Check it and try again.";
    case "password":
      return "This account has a two-step password.";
    case "password_wrong":
      return "That password wasn't right.";
    case "flood":
      if (!seconds) {
        return "Telegram is asking us to slow down for a while.";
      }
      // Rounding up, never down: a wait that says "1 minute" for 61 seconds is
      // how a retry gets spent on the same flood.
      return seconds <= 60
        ? "Telegram is asking us to slow down. Try again in a minute."
        : `Telegram is asking us to slow down. Try again in ${Math.ceil(seconds / 60)} minutes.`;
    case "session_dead":
      return "This Telegram session has ended, so you'll need to connect again.";
    case "duplicate_key":
      return "This account was opened somewhere else at the same time. Try again in a moment.";
    case "blocked":
      return "Telegram blocked this message. The person may not accept messages from strangers.";
    case "privacy":
      return "This person's privacy settings don't allow messages from you.";
    case "stale_peer":
      return "That chat has moved on since we last saw it. Send it again and we'll look it up afresh.";
    case "config":
      return "Telegram rejected this app's own credentials. That's ours to fix, not yours.";
    default:
      return `Telegram refused that (${name}).`;
  }
}

/** Whether the stored session is gone and the row must go back to Not connected. */
export function isSessionDead(kind: TelegramErrorKind): boolean {
  return kind === "session_dead";
}

/* -------------------------------------------------------------- send rate caps */

/**
 * The limits on sending, in one place so they can be argued with.
 *
 * Telegram's own docs are explicit that flooding means being banned, and that
 * accounts logging in through unofficial clients are watched. These are well
 * under anything a person would hit by hand, and the cold cap is much lower
 * because a first message to a stranger lands in their message requests, which
 * is the path that gets reported as spam.
 */
export interface SendCaps {
  /** Floor between two sends, so a burst never leaves as a burst. */
  minGapMs: number;
  perHour: number;
  perDay: number;
  /** First-ever message to one person. */
  coldPerDay: number;
}

export const SEND_CAPS: SendCaps = {
  minGapMs: 3_000,
  perHour: 10,
  perDay: 40,
  coldPerDay: 5,
};

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface SendCapVerdict {
  allowed: boolean;
  /** Plain enough to be spoken; null when allowed. */
  reason: string | null;
  /** Epoch ms at which this would be allowed again, when it is only a wait. */
  retryAt: number | null;
}

/**
 * Whether one more message may go out now.
 *
 * Takes the timestamps of previous sends rather than counting them, because
 * every cap here is a sliding window and a fixed counter would let a burst
 * through at a boundary.
 */
export function checkSendCaps(input: {
  sentAt: readonly number[];
  coldSentAt: readonly number[];
  /** True when this would be the first message ever to this person. */
  isCold: boolean;
  now: number;
  caps?: SendCaps;
}): SendCapVerdict {
  const caps = input.caps ?? SEND_CAPS;
  const { now } = input;

  const newest = input.sentAt.reduce((max, t) => (t > max ? t : max), -Infinity);
  if (newest !== -Infinity && now - newest < caps.minGapMs) {
    return {
      allowed: false,
      reason: "Give it a few seconds between messages.",
      retryAt: newest + caps.minGapMs,
    };
  }

  const inHour = input.sentAt.filter((t) => now - t < HOUR_MS);
  if (inHour.length >= caps.perHour) {
    return {
      allowed: false,
      reason: `That's ${caps.perHour} messages in an hour, which is as many as this will send. Try again later.`,
      retryAt: Math.min(...inHour) + HOUR_MS,
    };
  }

  const inDay = input.sentAt.filter((t) => now - t < DAY_MS);
  if (inDay.length >= caps.perDay) {
    return {
      allowed: false,
      reason: `That's ${caps.perDay} messages today, which is the daily limit. Try again tomorrow.`,
      retryAt: Math.min(...inDay) + DAY_MS,
    };
  }

  if (input.isCold) {
    const coldToday = input.coldSentAt.filter((t) => now - t < DAY_MS);
    if (coldToday.length >= caps.coldPerDay) {
      return {
        allowed: false,
        reason: `That's ${caps.coldPerDay} first-time messages today. Sending to someone new is the riskiest thing this can do, so it stops there.`,
        retryAt: Math.min(...coldToday) + DAY_MS,
      };
    }
  }

  return { allowed: true, reason: null, retryAt: null };
}

/* ---------------------------------------------------------------- repeat sends */

/**
 * How long the same text to the same person counts as already sent.
 *
 * A send goes out on the first request, and a voice call can ask for the same
 * thing again — the caller repeats "send it", or asks whether it went — with
 * every request re-reading the whole conversation. Within this window a repeat
 * is answered as done rather than sent a second time.
 */
export const REPEAT_SEND_WINDOW_MS = 15 * 60 * 1000;

/** When an identical message last went to this person within the window, or null. */
export function repeatSentAt(
  previous: readonly { text: string; at: number }[],
  text: string,
  now: number,
): number | null {
  const wanted = sameText(text);
  let latest: number | null = null;
  for (const sent of previous) {
    if (now - sent.at >= REPEAT_SEND_WINDOW_MS) continue;
    if (sameText(sent.text) !== wanted) continue;
    if (latest === null || sent.at > latest) latest = sent.at;
  }
  return latest;
}

/** Spacing and case are where a model's retelling of one message drifts. */
function sameText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
