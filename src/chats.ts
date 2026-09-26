/**
 * Call history: one chat per conversation, and the lines spoken inside it.
 *
 * The voice agent writes a chat as the call runs, so the site can list recent
 * calls without asking the Durable Object anything, and open one to read it
 * back or carry it into a new call. Nothing here touches the Worker or the
 * agent, so the wording of a timestamp and the way a list is grouped can be
 * tested without a browser.
 *
 * Every read is scoped by user id: a chat id is guessable enough to appear in a
 * URL, so ownership is checked in SQL rather than by the caller remembering to.
 */

export type ChatChannel = "site" | "phone";

/** One conversation, without its lines. */
export interface ChatSummary {
  id: string;
  channel: ChatChannel;
  title: string;
  startedAt: string;
  updatedAt: string;
  /** How many lines were spoken, and how long they took, for the list's second line. */
  lines: number;
  seconds: number;
}

/** The two sides of a call, with or without the time each one landed. */
export interface SpokenLine {
  role: "user" | "assistant";
  text: string;
}

export interface ChatLine extends SpokenLine {
  at: string;
}

/** A line on its way into the database, which needs its position. */
export interface StoredLine extends ChatLine {
  seq: number;
}

/** Titles are shown in a narrow column, so they are cut rather than wrapped. */
export const TITLE_MAX = 64;

export function isChatChannel(value: string): value is ChatChannel {
  return value === "site" || value === "phone";
}

/**
 * Chat ids reach the site through `/chat/<id>`, so a shape check keeps anything
 * that is not an id we could have minted out of the database entirely.
 */
export function isChatId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/**
 * The list's title: what the caller asked for first.
 *
 * A call that never got a word out of the caller falls back to what the agent
 * said, and a call with no words at all is named after where it came from, so
 * the row is never blank.
 */
export function chatTitle(lines: readonly SpokenLine[], channel: ChatChannel): string {
  const firstUser = lines.find((line) => line.role === "user" && line.text.trim());
  if (firstUser) return clipTitle(firstUser.text);
  const firstAssistant = lines.find((line) => line.role === "assistant" && line.text.trim());
  if (firstAssistant) return clipTitle(firstAssistant.text);
  return channel === "phone" ? "Phone call" : "Call";
}

/** Whitespace collapses first: spoken text arrives with the line breaks of a transcript. */
export function clipTitle(text: string, max = TITLE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Inserted between the transcript and a greeting that continues it. */
export function transcriptText(lines: readonly SpokenLine[]): string {
  return lines
    .filter((line) => line.text.trim())
    .map((line) => `${line.role === "user" ? "Caller" : "You"}: ${line.text.trim()}`)
    .join("\n");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How long ago, in words, or the date once "ago" stops being useful.
 *
 * Deliberately says nothing about the clock: the list is rendered on the server
 * in UTC, and "09:41" would be the wrong 09:41 for most callers. The absolute
 * time is put on the element's title by a script, where the browser's own zone
 * is available.
 */
export function whenPhrase(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "a minute ago";
  if (seconds < HOUR / 1000) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 90 * 60) return "an hour ago";
  if (seconds < 6 * (HOUR / 1000)) return `${Math.round(seconds / 3600)} hours ago`;
  const days = dayDelta(iso, now);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const sameYear = at.getUTCFullYear() === now.getUTCFullYear();
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${sameYear ? "" : ` ${at.getUTCFullYear()}`}`;
}

/** Whole calendar days between two instants, counted in UTC. */
export function dayDelta(iso: string, now: Date): number {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 0;
  const startOfDay = (date: Date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * An exact instant, pinned to UTC and labelled as such.
 *
 * This is what a header shows before the browser rewrites it in the caller's own
 * zone: naming the zone is better than showing a time that quietly belongs to
 * another one.
 */
export function absoluteWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${pad(at.getUTCHours())}:${pad(
    at.getUTCMinutes(),
  )} UTC`;
}

/** The headings the history page groups days under. */
export function dayGroup(iso: string, now: Date): string {
  const days = dayDelta(iso, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  return "Earlier";
}

export interface ChatGroup {
  label: string;
  chats: ChatSummary[];
}

/** Grouped in order, with empty groups dropped, so the page can render headings straight off. */
export function groupByDay(chats: readonly ChatSummary[], now: Date): ChatGroup[] {
  const groups: ChatGroup[] = [];
  for (const chat of chats) {
    const label = dayGroup(chat.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.chats.push(chat);
    else groups.push({ label, chats: [chat] });
  }
  return groups;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/* -------------------------------------------------------------------- D1 */

interface ChatRow {
  id: string;
  channel: string;
  title: string;
  started_at: string;
  updated_at: string;
  lines: number;
  seconds: number;
}

function toSummary(row: ChatRow): ChatSummary {
  return {
    id: row.id,
    channel: isChatChannel(row.channel) ? row.channel : "site",
    title: row.title,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    lines: row.lines,
    seconds: row.seconds,
  };
}

export async function listChats(db: D1Database, userId: string, limit: number): Promise<ChatSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, channel, title, started_at, updated_at, lines, seconds
         FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<ChatRow>();
  return (results ?? []).map(toSummary);
}

export async function countChats(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM chats WHERE user_id = ?")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Null when there is no such chat, or it belongs to someone else. */
export async function readChat(
  db: D1Database,
  userId: string,
  id: string,
): Promise<{ chat: ChatSummary; lines: ChatLine[] } | null> {
  const row = await db
    .prepare(
      `SELECT id, channel, title, started_at, updated_at, lines, seconds
         FROM chats WHERE id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .first<ChatRow>();
  if (!row) return null;
  const { results } = await db
    .prepare("SELECT seq, role, text, at FROM chat_lines WHERE chat_id = ? ORDER BY seq")
    .bind(id)
    .all<{ seq: number; role: string; text: string; at: string }>();
  const lines = (results ?? []).map((line) => ({
    role: (line.role === "user" ? "user" : "assistant") as ChatLine["role"],
    text: line.text,
    at: line.at,
  }));
  return { chat: toSummary(row), lines };
}

/* --------------------------------------------------- written by the agent */

export interface NewChat {
  id: string;
  userId: string;
  channel: ChatChannel;
  title: string;
  at: string;
}

/**
 * Opened on the first line of a call, not when the call connects: a call nobody
 * spoke on should not leave an empty row in the history.
 */
export async function beginChat(db: D1Database, chat: NewChat): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chats (id, user_id, channel, title, started_at, updated_at, lines)
         VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(chat.id, chat.userId, chat.channel, chat.title, chat.at, chat.at)
    .run();
}

export interface ChatWrite {
  lines: readonly StoredLine[];
  /** How many lines are already stored, so only the tail is sent again. */
  from: number;
  title: string;
  updatedAt: string;
}

/**
 * Writes the lines from `from` onwards and moves the chat's timestamp.
 *
 * The last line goes again on every flush because it is still growing: a line is
 * persisted repeatedly as it is spoken, and only stops changing when the next
 * one starts. The title is rewritten alongside, since the caller's first words
 * arrive after the agent's greeting and are the better name for the chat.
 */
export async function writeChatLines(db: D1Database, chatId: string, write: ChatWrite): Promise<void> {
  const pending = write.lines.slice(Math.max(0, write.from));
  if (!pending.length) return;
  const statements = pending.map((line) =>
    db
      .prepare(
        `INSERT INTO chat_lines (chat_id, seq, role, text, at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (chat_id, seq) DO UPDATE SET text = excluded.text`,
      )
      .bind(chatId, line.seq, line.role, line.text, line.at),
  );
  // How many lines the chat holds altogether, which is one more than the
  // highest sequence: a call that continues an earlier one starts writing after
  // those lines rather than at zero, so their number is counted too.
  const total = write.lines.reduce((most, line) => Math.max(most, line.seq + 1), 0);
  statements.push(
    db
      .prepare("UPDATE chats SET updated_at = ?, title = ?, lines = ? WHERE id = ?")
      .bind(write.updatedAt, write.title, total, chatId),
  );
  await db.batch(statements);
}

/** Called when the call ends, so the list can show how long it ran. */
export async function endChat(
  db: D1Database,
  chatId: string,
  endedAt: string,
  seconds: number,
): Promise<void> {
  await db
    .prepare("UPDATE chats SET ended_at = ?, seconds = seconds + ? WHERE id = ?")
    .bind(endedAt, Math.max(0, Math.round(seconds)), chatId)
    .run();
}

/**
 * Everything one call writes to its chat.
 *
 * The voice agent speaks in deltas — many a second, each one extending the line
 * being said — and a chat has to survive all of them without a write per token
 * and without losing the line in progress. So the lines are held here, written
 * in batches, and only the growing tail is sent again.
 *
 * This is separate from the agent so the bookkeeping can be tested directly:
 * what gets written when, which lines a continued call appends after, and that
 * a call nobody spoke on leaves nothing behind.
 */
export class ChatRecorder {
  /** The chat's id, which changes only if the one asked for is not the caller's. */
  id: string;
  readonly channel: ChatChannel;
  readonly startedAt: string;
  private readonly db: D1Database;
  private readonly userId: string;
  private readonly clock: () => Date;
  private readonly callStartedAt: number;
  /** Cleared when the chat asked for is not there or is not the caller’s. */
  private continuing: boolean;
  private earlier: ChatLine[] = [];
  private lines: ChatLine[] = [];
  /** How many of `lines` are already stored. */
  private persisted = 0;
  private wrote = false;
  private ended = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: {
    db: D1Database;
    userId: string;
    channel: ChatChannel;
    /** The chat the page asked to continue, if any. */
    resumeId?: string | null;
    /** Injectable so a test can decide what "now" is. */
    now?: () => Date;
  }) {
    this.db = options.db;
    this.userId = options.userId;
    this.channel = options.channel;
    this.clock = options.now ?? (() => new Date());
    this.callStartedAt = this.clock().getTime();
    this.startedAt = this.clock().toISOString();
    this.continuing = Boolean(options.resumeId && isChatId(options.resumeId));
    this.id = this.continuing ? (options.resumeId as string) : crypto.randomUUID();
  }

  /** Whether this call adds to an existing chat rather than opening one. */
  get continues(): boolean {
    return this.continuing;
  }

  /** The conversation this call continues, oldest first. */
  get resumed(): readonly ChatLine[] {
    return this.earlier;
  }

  /** What has been said on this call. */
  get spoken(): readonly ChatLine[] {
    return this.lines;
  }

  get said(): number {
    return this.lines.length;
  }

  /**
   * Reads back the chat this call continues.
   *
   * A chat that is not there, or is not the caller's, leaves a new one in its
   * place: a stale link should still get them a working call.
   */
  async load(): Promise<void> {
    if (!this.continuing) return;
    const found = await readChat(this.db, this.userId, this.id);
    if (!found) {
      // A chat that is gone, or was never theirs, is not one to add to.
      this.continuing = false;
      this.id = crypto.randomUUID();
      return;
    }
    this.earlier = found.lines;
  }

  /**
   * Adds what was just said. Deltas of the same speaker extend the same line,
   * which is what makes a transcript read as turns rather than as fragments.
   */
  addLine(role: SpokenLine["role"], delta: string): void {
    if (!delta) return;
    const last = this.lines[this.lines.length - 1];
    if (last?.role === role) last.text += delta;
    else this.lines.push({ role, text: delta, at: this.clock().toISOString() });
  }

  /** The call so far, including whatever an earlier call left behind. */
  text(limit = 8000): string {
    return [transcriptText(this.earlier), transcriptText(this.lines)]
      .filter(Boolean)
      .join("\n")
      .slice(-limit);
  }

  title(): string {
    return chatTitle([...this.earlier, ...this.lines], this.channel);
  }

  /**
   * What a continued call opens with. Without it "and send that to him" would
   * reach the backend with no "that" anywhere in the conversation.
   */
  resumePrompt(): string {
    if (!this.earlier.length) return "";
    const said = transcriptText(this.earlier).slice(-3000);
    if (!said) return "";
    return `This call continues an earlier conversation with the same person. Here is what was said then, oldest first:

${said}

Pick up where that left off. Greet them in a few words and carry on; do not introduce yourself again or explain what you can do.`;
  }

  /**
   * Writes the lines spoken since the last flush.
   *
   * Resolves to whether this flush is what created the chat: the row is opened
   * on the first line of a call rather than when it connects, so a call nobody
   * spoke on leaves no empty entry in the history. Flushes are chained because
   * two in flight would race over the same rows.
   */
  async flush(): Promise<{ opened: boolean }> {
    let opened = false;
    const run = async () => {
      if (!this.lines.length) return;
      if (!this.wrote) {
        // A call that continues an earlier one writes into a row that is
        // already there, so only a new conversation opens one.
        if (!this.continuing) {
          await beginChat(this.db, {
            id: this.id,
            userId: this.userId,
            channel: this.channel,
            title: this.title(),
            at: this.startedAt,
          });
          opened = true;
        }
        this.wrote = true;
      }
      await writeChatLines(this.db, this.id, {
        lines: this.lines.map((line, index) => ({
          seq: this.earlier.length + index,
          role: line.role,
          text: line.text,
          at: line.at,
        })),
        from: Math.max(0, this.persisted - 1),
        title: this.title(),
        updatedAt: this.clock().toISOString(),
      });
      this.persisted = this.lines.length;
    };
    const queued = this.queue.then(run);
    this.queue = queued.catch(() => {});
    await queued;
    return { opened };
  }

  /** Closes the chat off with how long the call ran. Only the first call counts. */
  async finish(): Promise<boolean> {
    if (this.ended) return false;
    this.ended = true;
    await this.flush();
    const seconds = Math.max(0, (this.clock().getTime() - this.callStartedAt) / 1000);
    await endChat(this.db, this.id, this.clock().toISOString(), seconds);
    return true;
  }
}
