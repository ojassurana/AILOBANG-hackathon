/**
 * One Durable Object per user, holding that user's own Telegram account.
 *
 * This is a **user session**, not a bot: the caller logs in with their phone
 * number and Telegram issues a session for their real account. There is no
 * read-only scope for such a session, which is why every send goes through a
 * confirmation and why the caps in `telegram-session.ts` exist.
 *
 * Three properties are structural here rather than promised:
 *
 * 1. **No past messages.** The message table is created at login and filled only
 *    from `updates.getDifference`, which returns what happened *after* the point
 *    we recorded. Nothing in this file calls `getHistory`, `getDialogs` or
 *    `getPeerDialogs`, so there is no code path that could return a message from
 *    before the user connected.
 * 2. **No clearing of unread badges.** `readHistory` is never called, so reading
 *    through us does not mark anything read in the user's own apps.
 * 3. **No idle connection.** An open socket stops the object hibernating and is
 *    billed by wall clock, so the client is closed in a `finally` after every
 *    operation, with a short alarm as a backstop.
 */

import { DurableObject } from "cloudflare:workers";
import { Api, TelegramClient, errors } from "teleproto";
import { StringSession } from "teleproto/sessions";
import type { Env } from "./env";
import {
  type PendingSend,
  type TelegramLoginState,
  type TelegramPhase,
  classifyTelegramError,
  checkSendCaps,
  codeRejected,
  codeSent,
  isSessionDead,
  loginConnected,
  loginFailed,
  passwordNeeded,
  pendingSendExpired,
  restartLogin,
} from "./telegram-session";
import { password as passwordHelper } from "teleproto";

/**
 * How much of the conversation we keep. Both limits are deliberately small: the
 * point of reading forward from connection is to speak to what is happening now,
 * and keeping a long archive would turn a live view into a history store.
 */
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_MESSAGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Pages of `getDifference` to walk before giving up on catching up. */
const MAX_DIFFERENCE_PAGES = 20;
/**
 * A socket must never be left open. The client is closed explicitly after every
 * operation; this alarm is the backstop for a path that threw before its
 * `finally` ran, and it is short because an open socket is what costs money.
 */
const IDLE_ALARM_MS = 60 * 1000;
const CONNECT_TIMEOUT_MS = 20 * 1000;

/** What the row on /app and the step screen need to know. */
export interface TelegramStatus {
  phase: TelegramPhase;
  phone: string | null;
  /** The account's own @handle, once we have logged in and asked for it. */
  username: string | null;
  /** A sentence for the user; never a raw Telegram error name. */
  error: string | null;
  /** Epoch ms before which retrying is pointless. */
  retryAt: number | null;
  /**
   * Whether the pending code went to another Telegram app rather than by SMS.
   * The step screen says which, because looking in the wrong place is the
   * commonest reason a code is reported as never arriving.
   */
  codeViaApp: boolean;
  hasSession: boolean;
}

export interface ChatSummary {
  chat: string;
  title: string;
  lastMessageAt: number;
  unreadFromThem: number;
}

export interface MessageLine {
  from: string;
  outgoing: boolean;
  text: string;
  at: number;
}

export interface Recipient {
  username: string;
  title: string;
  /** Whether we have never sent to this person, which is the risky case. */
  cold: boolean;
}

export interface PrepareResult {
  /** False when the send was refused, with `reason` saying why. */
  ok: boolean;
  reason: string | null;
  to: string | null;
  title: string | null;
  /** Exactly the text to read back for confirmation. */
  text: string | null;
}

export interface SendResult {
  ok: boolean;
  reason: string | null;
  to: string | null;
  title: string | null;
}

// `SqlStorageValue` is what the Durable Object SQL cursor can hand back, so the
// row shapes are declared as records of it rather than as loose interfaces.
interface LoginRow extends Record<string, SqlStorageValue> {
  session: string | null;
  phase: string;
  phone: string | null;
  phone_code_hash: string | null;
  code_via_app: number | null;
  code_sent_at: number | null;
  attempts: number | null;
  error: string | null;
  retry_at: number | null;
  username: string | null;
}

interface UpdatesRow extends Record<string, SqlStorageValue> {
  pts: number;
  qts: number;
  date: number;
}

/**
 * Extends the provided base class rather than the `DurableObject` interface: the
 * base class carries the brand that makes `DurableObjectStub<TelegramSession>`
 * expose these methods as RPC. Implementing the interface alone type-checks the
 * object but leaves every caller unable to name a method on the stub.
 */
export class TelegramSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.createSchema();
    });
  }

  /**
   * One live client at a time. Two sockets on one auth key make Telegram answer
   * `AUTH_KEY_DUPLICATED` and can invalidate the key outright.
   */
  private client: TelegramClient | null = null;

  /**
   * The session string as it stood when the socket last closed.
   *
   * The auth key only lives in the session object between `connect()` and
   * `disconnect()`, and Telegram ties a login's phone code hash to the key that
   * asked for it. Callers persist the session after the exchange has finished,
   * by which point the client is gone, so the value has to be kept as the client
   * goes away rather than read back out of it later.
   */
  private sessionAtClose: string | null = null;

  /**
   * There is no HTTP surface. The binding is reachable at
   * `/agents/telegram-session/<name>` because the agents router exposes every
   * Durable Object binding, so this closes that route instead of leaving it to
   * luck.
   */
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  /* ------------------------------------------------------------------ schema */

  private createSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS login (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      session TEXT,
      phase TEXT NOT NULL,
      phone TEXT,
      phone_code_hash TEXT,
      code_via_app INTEGER,
      code_sent_at INTEGER,
      attempts INTEGER,
      error TEXT,
      retry_at INTEGER,
      username TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS updates_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pts INTEGER NOT NULL,
      qts INTEGER NOT NULL,
      date INTEGER NOT NULL
    )`);
    // The chat key is `user:<id>` for a direct message. Groups and channels are
    // out of scope for this version and are not stored.
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      chat TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      chat_title TEXT,
      from_name TEXT,
      outgoing INTEGER NOT NULL,
      text TEXT,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (chat, message_id)
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (chat, sent_at)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_by_age ON messages (sent_at)`);
    /** One row per person we have ever sent to, for the cold-contact cap. */
    sql.exec(`CREATE TABLE IF NOT EXISTS recipients (
      username TEXT PRIMARY KEY,
      title TEXT,
      first_sent_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      cold INTEGER NOT NULL,
      chat TEXT NOT NULL
    )`);
    /** At most one row, ever: the single message awaiting a yes. */
    sql.exec(`CREATE TABLE IF NOT EXISTS pending_send (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      to_text TEXT NOT NULL,
      to_label TEXT NOT NULL,
      text TEXT NOT NULL,
      prepared_at INTEGER NOT NULL
    )`);
  }

  /* ------------------------------------------------------------- login state */

  private readLogin(): LoginRow {
    const rows = this.ctx.storage.sql
      .exec<LoginRow>(`SELECT * FROM login WHERE id = 1`)
      .toArray();
    if (rows.length) return rows[0];
    return {
      session: null,
      phase: "idle",
      phone: null,
      phone_code_hash: null,
      code_via_app: null,
      code_sent_at: null,
      attempts: null,
      error: null,
      retry_at: null,
      username: null,
    };
  }

  private writeLogin(state: TelegramLoginState, patch: Partial<LoginRow> = {}): void {
    const current = this.readLogin();
    const next: LoginRow = {
      session: patch.session !== undefined ? patch.session : current.session,
      phase: state.phase,
      phone: state.phone,
      phone_code_hash: state.phoneCodeHash,
      code_via_app: state.codeViaApp ? 1 : 0,
      code_sent_at: state.codeSentAt,
      attempts: state.attempts,
      error: state.error,
      retry_at: state.retryAt,
      username: patch.username !== undefined ? patch.username : current.username,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO login (id, session, phase, phone, phone_code_hash, code_via_app, code_sent_at, attempts, error, retry_at, username)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session = excluded.session, phase = excluded.phase, phone = excluded.phone,
         phone_code_hash = excluded.phone_code_hash, code_via_app = excluded.code_via_app,
         code_sent_at = excluded.code_sent_at, attempts = excluded.attempts,
         error = excluded.error, retry_at = excluded.retry_at, username = excluded.username`,
      next.session,
      next.phase,
      next.phone,
      next.phone_code_hash,
      next.code_via_app,
      next.code_sent_at,
      next.attempts,
      next.error,
      next.retry_at,
      next.username,
    );
  }

  private loginState(): TelegramLoginState {
    const row = this.readLogin();
    return {
      phase: row.phase as TelegramPhase,
      phone: row.phone,
      phoneCodeHash: row.phone_code_hash,
      codeViaApp: row.code_via_app === 1,
      codeSentAt: row.code_sent_at,
      attempts: row.attempts ?? 0,
      error: row.error,
      retryAt: row.retry_at,
    };
  }

  /**
   * Wipes the login and everything read through it. Called on logout, so that
   * disconnecting really does erase what we saw rather than just hiding it.
   */
  private wipe(): void {
    this.sessionAtClose = null;
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM login`);
    sql.exec(`DELETE FROM updates_state`);
    sql.exec(`DELETE FROM messages`);
    sql.exec(`DELETE FROM recipients`);
    sql.exec(`DELETE FROM send_log`);
    sql.exec(`DELETE FROM pending_send`);
  }

  /* ---------------------------------------------------------------- sessions */

  private apiId(): number {
    const id = Number(this.env.TELEGRAM_API_ID);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("TELEGRAM_API_ID is not set to a number");
    }
    return id;
  }

  private session(): StringSession {
    return new StringSession(this.readLogin().session ?? "");
  }

  /**
   * Opens a client and arms the backstop alarm.
   *
   * `connectionRetries` must be at least 1: with 0 the library's retry loop never
   * runs and every failure surfaces as a bare "Failed to connect" with the real
   * cause discarded. `autoReconnect` is off for the same reason it is off in any
   * request/response path — we are not keeping this socket.
   */
  private async openClient(): Promise<TelegramClient> {
    if (this.client) return this.client;

    const client = new TelegramClient(this.session(), this.apiId(), this.env.TELEGRAM_API_HASH, {
      connectionRetries: 2,
      retryDelay: 250,
      autoReconnect: false,
      // A flood must surface as an error we can classify, never as the library
      // quietly sleeping on our wall clock.
      floodSleepThreshold: 0,
      deviceModel: "Ailobang",
      systemVersion: "cloudflare-workers",
      appVersion: "1.0.0",
    });

    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Telegram connect timed out")), CONNECT_TIMEOUT_MS),
      ),
    ]);

    this.client = client;
    // Only now is a socket open, so only now is an alarm worth its write.
    await this.ctx.storage.setAlarm(Date.now() + IDLE_ALARM_MS);
    return client;
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    // Before the reference goes: this is the last moment the auth key exists.
    if (client) this.sessionAtClose = this.liveSessionString();
    this.client = null;
    await this.ctx.storage.deleteAlarm();
    if (!client) return;
    try {
      await client.disconnect();
    } catch (error) {
      // A socket that is already gone is the desired end state either way.
      console.error("telegram: disconnect failed", error);
    }
  }

  /**
   * Runs one exchange against a client and always closes it. Every public method
   * that talks to Telegram goes through here, which is what makes "never left
   * open" a property of the shape of the code rather than of remembering.
   */
  private async withClient<T>(run: (client: TelegramClient) => Promise<T>): Promise<T> {
    const client = await this.openClient();
    try {
      return await run(client);
    } finally {
      await this.closeClient();
    }
  }

  /** The backstop: nothing should still be open when this fires. */
  async alarm(): Promise<void> {
    await this.closeClient();
  }

  /* ------------------------------------------------------------------ status */

  async status(): Promise<TelegramStatus> {
    const row = this.readLogin();
    return {
      phase: row.phase as TelegramPhase,
      phone: row.phone,
      username: row.username,
      error: row.error,
      retryAt: row.retry_at,
      codeViaApp: row.code_via_app === 1,
      hasSession: Boolean(row.session),
    };
  }

  /* ------------------------------------------------------------------- login */

  /** Step one: ask Telegram to send a code to this number. */
  async beginLogin(phone: string): Promise<TelegramStatus> {
    const normalized = phone.replace(/[^\d+]/g, "");
    await this.closeClient();

    try {
      const result = await this.withClient((client) =>
        client.invoke(
          new Api.auth.SendCode({
            phoneNumber: normalized,
            apiId: this.apiId(),
            apiHash: this.env.TELEGRAM_API_HASH,
            settings: new Api.CodeSettings({}),
          }),
        ),
      );

      // `SentCodeSuccess` means this session is already authorised, which can
      // only happen if a previous attempt got further than we recorded.
      if (result.className === "auth.SentCodeSuccess") {
        await this.finishLogin();
        return this.status();
      }

      const sent = result as Api.auth.SentCode;
      const viaApp = sent.type?.className === "auth.SentCodeTypeApp";
      // The auth key created by this call is what the code will be checked
      // against, so it has to survive the disconnect that follows. Without it
      // the next step opens a different key, and Telegram then rejects even a
      // correct code as expired — which reads to the user as a wrong code.
      const next = codeSent(normalized, sent.phoneCodeHash, viaApp, Date.now());
      const session = this.liveSessionString();
      if (!session) {
        this.writeLogin(
          { ...restartLogin(next), error: "That sign-in didn't stick. Try again." },
          { session: null },
        );
        return this.status();
      }
      this.writeLogin(next, { session });
    } catch (error) {
      this.recordLoginError(error, normalized);
    }

    return this.status();
  }

  /** Step two: the code from Telegram's own message. */
  async submitCode(code: string): Promise<TelegramStatus> {
    const current = this.loginState();
    if (!current.phone || !current.phoneCodeHash) {
      return this.status();
    }

    // Telegram only honours a code hash for the session that asked for it. With
    // no session on the row there is nothing left to check the code against, so
    // every code would come back wrong; send them to step one, where a fresh
    // code is one button away, rather than letting them type into a dead step.
    if (!this.readLogin().session) {
      this.writeLogin(
        {
          ...restartLogin(current),
          error: "That code can't be checked any more. Enter your number for a new one.",
        },
        { session: null },
      );
      return this.status();
    }

    try {
      const authorization = await this.withClient(async (client) => {
        const result = await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: current.phone!,
            phoneCodeHash: current.phoneCodeHash!,
            phoneCode: code.replace(/\s/g, ""),
          }),
        );
        this.writeLogin(current, { session: this.liveSessionString() });
        return result;
      });

      if (authorization.className === "auth.AuthorizationSignUpRequired") {
        this.writeLogin(
          loginFailed(
            current,
            "That number isn't a Telegram account yet. Sign up in the app first.",
          ),
        );
        return this.status();
      }

      await this.finishLogin();
    } catch (error) {
      if (error instanceof errors.SessionPasswordNeededError) {
        this.writeLogin(passwordNeeded(current), { session: this.liveSessionString() });
        return this.status();
      }
      const classified = classifyTelegramError(error, telegramErrorShape(error));
      if (classified.kind === "bad_code") {
        this.writeLogin(codeRejected(current, classified.message));
        return this.status();
      }
      this.recordLoginError(error);
    }

    return this.status();
  }

  /** Step three, only when the account has a two-step password. */
  async submitPassword(password: string): Promise<TelegramStatus> {
    const current = this.loginState();
    try {
      await this.withClient(async (client) => {
        const check = await passwordHelper.computeCheck(
          await client.invoke(new Api.account.GetPassword()),
          password,
        );
        await client.invoke(new Api.auth.CheckPassword({ password: check }));
        this.writeLogin(current, { session: this.liveSessionString() });
      });
      await this.finishLogin();
    } catch (error) {
      if (error instanceof errors.SessionPasswordNeededError) {
        this.writeLogin({ ...passwordNeeded(current), error: "That password wasn't right." });
        return this.status();
      }
      this.recordLoginError(error);
    }

    return this.status();
  }

  async restartLogin(): Promise<TelegramStatus> {
    const state = restartLogin(this.loginState());
    await this.closeClient();
    this.sessionAtClose = null;
    this.writeLogin(state, { session: null });
    return this.status();
  }

  /** Ends the session at Telegram's end too, not just ours. */
  async logout(): Promise<void> {
    try {
      await this.withClient((client) => client.invoke(new Api.auth.LogOut()));
    } catch (error) {
      // If the session is already dead there is nothing to revoke, and the local
      // wipe below is what the user asked for either way.
      console.error("telegram: logOut failed, wiping locally", error);
    }
    await this.closeClient();
    this.wipe();
  }

  /**
   * The session string the last exchange used.
   *
   * While a client is open this reads it directly, because that is the only
   * moment it includes the auth key the exchange just used. Between exchanges it
   * falls back to what `closeClient` kept, so a caller persisting the session
   * after the fact still gets that key rather than nothing.
   */
  private liveSessionString(): string | null {
    if (!this.client) return this.sessionAtClose;
    try {
      return String(this.client.session.save()) || null;
    } catch (error) {
      console.error("telegram: could not save session", error);
      return null;
    }
  }

  /**
   * The last step of every successful login: record who we are, take the update
   * line, and keep the session.
   */
  private async finishLogin(): Promise<void> {
    const session = this.liveSessionString();
    try {
      const me = await this.withClient(async (client) => {
        const user = await client.getMe();
        const state = await client.invoke(new Api.updates.GetState());
        return { user, state };
      });

      const username = me.user?.username ?? null;
      this.writeLogin(loginConnected(Date.now()), {
        session: session ?? this.liveSessionString(),
        username,
      });

      // The cut line. Everything we will ever read is after this point, and
      // `getDifference` is what advances it.
      this.ctx.storage.sql.exec(`DELETE FROM updates_state`);
      this.ctx.storage.sql.exec(
        `INSERT INTO updates_state (id, pts, qts, date) VALUES (1, ?, ?, ?)`,
        me.state.pts,
        me.state.qts,
        me.state.date,
      );
      // A new login means the old reading is not this account's.
      this.ctx.storage.sql.exec(`DELETE FROM messages`);
    } catch (error) {
      this.recordLoginError(error);
    }
  }

  /** Turns anything thrown during login into the state the screens render. */
  private recordLoginError(error: unknown, phone?: string): void {
    const classified = classifyTelegramError(error, telegramErrorShape(error));
    if (isSessionDead(classified.kind)) {
      // Nothing usable is stored any more, so the row goes back to Not connected.
      this.wipe();
      return;
    }
    const retryAt = classified.seconds ? Date.now() + classified.seconds * 1000 : null;
    // `phone` is passed only by `beginLogin`, which can fail before anything has
    // been written: without it the number the user just typed would be lost, and
    // they would have to enter it again to try the same thing twice.
    const current = this.loginState();
    this.writeLogin(
      loginFailed(phone ? { ...current, phone } : current, classified.message, retryAt),
    );
  }

  /* -------------------------------------------------------------------- reads */

  /**
   * Brings the local table up to date with what has happened since the last
   * call. This is the only way messages enter the object.
   */
  async sync(): Promise<number> {
    const state = this.readUpdatesState();
    if (!state) return 0;

    let pts = state.pts;
    let qts = state.qts;
    let date = state.date;
    let ingested = 0;

    try {
      await this.withClient(async (client) => {
        for (let page = 0; page < MAX_DIFFERENCE_PAGES; page++) {
          const difference = await client.invoke(
            new Api.updates.GetDifference({ pts, qts, date }),
          );

          if (difference.className === "updates.DifferenceEmpty") {
            break;
          }

          if (difference.className === "updates.DifferenceTooLong") {
            // Our position is unrecoverable. Telegram tells us where to resume;
            // the gap is lost, which is acceptable because we never promise
            // completeness — only what arrived while connected.
            this.resync((difference as Api.updates.DifferenceTooLong).pts);
            ingested = -1;
            break;
          }

          const slice = difference as Api.updates.Difference | Api.updates.DifferenceSlice;
          ingested += this.ingest(slice.newMessages, slice.users, slice.otherUpdates);

          const next =
            slice.className === "updates.Difference"
              ? (slice as Api.updates.Difference).state
              : (slice as Api.updates.DifferenceSlice).intermediateState;
          pts = next.pts;
          qts = next.qts;
          date = next.date;

          if (slice.className === "updates.Difference") break;
        }
      });

      if (ingested >= 0) this.writeUpdatesState({ pts, qts, date });
      this.trim();
    } catch (error) {
      // Recorded rather than thrown: catching up is best-effort, and a session
      // that has died is a state the row has to show, not a 500 for the caller.
      this.recordLoginError(error);
    }

    return ingested;
  }

  private resync(pts: number): void {
    const row = this.readUpdatesState();
    this.writeUpdatesState({ pts, qts: row?.qts ?? 0, date: row?.date ?? 0 });
  }

  /**
   * Stores the messages from one difference page and the names that go with
   * them. Only direct messages are kept; groups and channels are out of scope
   * for this version, so their messages are dropped rather than half-supported.
   */
  private ingest(
    messages: Api.TypeMessage[],
    users: Api.TypeUser[],
    otherUpdates: Api.TypeUpdate[],
  ): number {
    const names = new Map<string, string>();
    for (const user of users) {
      if (user.className === "User") {
        const u = user as Api.User;
        names.set(String(u.id), u.username ? `@${u.username}` : displayName(u));
      }
    }

    // A difference page carries new messages both directly and inside updates,
    // depending on their kind.
    const carried: Api.TypeMessage[] = [...messages];
    for (const update of otherUpdates) {
      if (
        update.className === "UpdateNewMessage" ||
        update.className === "UpdateNewChannelMessage" ||
        update.className === "UpdateEditMessage"
      ) {
        const inner = (update as Api.UpdateNewMessage).message;
        if (inner) carried.push(inner);
      }
    }

    let stored = 0;
    for (const message of carried) {
      if (message.className === "MessageEmpty") continue;
      const line = this.storable(message as Api.Message, names);
      if (!line) continue;
      this.ctx.storage.sql.exec(
        `INSERT INTO messages (chat, message_id, chat_title, from_name, outgoing, text, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat, message_id) DO UPDATE SET text = excluded.text`,
        line.chat,
        line.messageId,
        line.chatTitle,
        line.fromName,
        line.outgoing ? 1 : 0,
        line.text,
        line.sentAt,
      );
      stored++;
    }
    return stored;
  }

  /** Turns a Telegram message into a row, or null when it is not a DM we keep. */
  private storable(
    message: Api.Message,
    names: Map<string, string>,
  ): {
    chat: string;
    messageId: number;
    chatTitle: string;
    fromName: string;
    outgoing: boolean;
    text: string;
    sentAt: number;
  } | null {
    const peer = message.peerId;
    if (!peer || peer.className !== "PeerUser") return null;

    const otherId = String((peer as Api.PeerUser).userId);
    const senderId = message.fromId ? String((message.fromId as Api.PeerUser).userId) : otherId;
    const text = message.message ?? "";
    // A service message (someone joined, a call ended) has no text worth
    // speaking, and a sticker or photo has none either.
    if (!text) return null;

    return {
      chat: `user:${otherId}`,
      messageId: Number(message.id),
      chatTitle: names.get(otherId) ?? otherId,
      fromName: message.out ? "you" : (names.get(senderId) ?? senderId),
      outgoing: Boolean(message.out),
      text,
      sentAt: Number(message.date) * 1000,
    };
  }

  /** Both retention limits in one place: age first, then per-chat depth. */
  private trim(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM messages WHERE sent_at < ?`, Date.now() - MAX_MESSAGE_AGE_MS);
    sql.exec(
      `DELETE FROM messages WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid, ROW_NUMBER() OVER (PARTITION BY chat ORDER BY sent_at DESC) AS rank
           FROM messages
         ) WHERE rank > ?
       )`,
      MAX_MESSAGES_PER_CHAT,
    );
  }

  private readUpdatesState(): UpdatesRow | null {
    const rows = this.ctx.storage.sql
      .exec<UpdatesRow>(`SELECT pts, qts, date FROM updates_state WHERE id = 1`)
      .toArray();
    return rows.length ? rows[0] : null;
  }

  private writeUpdatesState(state: UpdatesRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO updates_state (id, pts, qts, date) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pts = excluded.pts, qts = excluded.qts, date = excluded.date`,
      state.pts,
      state.qts,
      state.date,
    );
  }

  /** The chats with something in them, most recent first. Local table only. */
  async listChats(limit = 20): Promise<ChatSummary[]> {
    await this.sync();
    return this.ctx.storage.sql
      .exec<{ chat: string; chat_title: string; last: number; unread: number }>(
        `SELECT chat,
                MAX(chat_title) AS chat_title,
                MAX(sent_at) AS last,
                SUM(CASE WHEN outgoing = 0 THEN 1 ELSE 0 END) AS unread
         FROM messages
         GROUP BY chat
         ORDER BY last DESC
         LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row) => ({
        chat: row.chat,
        title: row.chat_title,
        lastMessageAt: row.last,
        unreadFromThem: row.unread,
      }));
  }

  /**
   * The last few messages of one chat. Reads the local table, so nothing older
   * than the login can be returned even by accident.
   */
  async readMessages(chat: string, limit = 20): Promise<MessageLine[]> {
    await this.sync();
    const key = this.chatKey(chat);
    if (!key) return [];
    return this.ctx.storage.sql
      .exec<{ from_name: string; outgoing: number; text: string; sent_at: number }>(
        `SELECT from_name, outgoing, text, sent_at FROM (
           SELECT from_name, outgoing, text, sent_at FROM messages
           WHERE chat = ? ORDER BY sent_at DESC LIMIT ?
         ) ORDER BY sent_at ASC`,
        key,
        limit,
      )
      .toArray()
      .map((row) => ({
        from: row.from_name,
        outgoing: row.outgoing === 1,
        text: row.text,
        at: row.sent_at,
      }));
  }

  /**
   * Why nothing can be sent yet, or null when it can.
   *
   * Without this a send on an unconnected account would reach Telegram with an
   * empty session and come back as `AUTH_KEY_UNREGISTERED`, which reads like a
   * mysterious failure rather than "you haven't connected this yet".
   */
  private notConnectedReason(): string | null {
    const row = this.readLogin();
    if (row.phase === "connected" && row.session) return null;
    if (row.phase === "code" || row.phase === "password") {
      return "The Telegram login hasn't finished yet — the code still needs entering.";
    }
    return "Telegram isn't connected yet, so there's nothing to send from.";
  }

  /** Accepts either the stored key or the title/@handle the model was shown. */
  private chatKey(chat: string): string | null {
    if (/^user:\d+$/.test(chat)) return chat;
    const byTitle = this.ctx.storage.sql
      .exec<{ chat: string }>(
        `SELECT chat FROM messages WHERE chat_title = ? OR chat_title = ? LIMIT 1`,
        chat,
        chat.startsWith("@") ? chat : `@${chat}`,
      )
      .toArray();
    return byTitle.length ? byTitle[0].chat : null;
  }

  /* -------------------------------------------------------------------- send */

  /**
   * Looks a person up by handle. Usernames only, which is the whole of this
   * version's addressing: we never build a peer from a stored id, so a stale
   * access hash cannot be sent to by mistake.
   */
  async findRecipient(username: string): Promise<Recipient | null> {
    const handle = username.replace(/^@/, "").trim();
    if (!handle) return null;

    return this.withClient(async (client) => {
      const resolved = await client.invoke(
        new Api.contacts.ResolveUsername({ username: handle }),
      );
      const user = resolved.users.find((candidate) => candidate.className === "User") as
        | Api.User
        | undefined;
      if (!user) return null;

      const cold = !this.hasSentTo(handle);
      return {
        username: user.username ? `@${user.username}` : `@${handle}`,
        title: displayName(user) || (user.username ? `@${user.username}` : handle),
        cold,
      };
    });
  }

  private hasSentTo(username: string): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM recipients WHERE username = ?`, username)
      .toArray();
    return (rows[0]?.n ?? 0) > 0;
  }

  /**
   * Stores one message as the thing awaiting a yes, and sends nothing.
   *
   * Exactly one is kept: the caller's "yes" arrives as a separate request that
   * can only see the conversation, so it cannot quote an identifier back to us.
   * The single stored draft with a short life is what makes "send it" mean the
   * message just read back, and nothing staler.
   */
  async prepareSend(to: string, text: string): Promise<PrepareResult> {
    const body = text.trim();
    if (!body) return { ok: false, reason: "There was no message to send.", to: null, title: null, text: null };

    const blocked = this.notConnectedReason();
    if (blocked) {
      return { ok: false, reason: blocked, to: null, title: null, text: null };
    }

    const recipient = await this.findRecipient(to);
    if (!recipient) {
      return {
        ok: false,
        reason: `I couldn't find anyone with the username @${to.replace(/^@/, "")}.`,
        to: null,
        title: null,
        text: null,
      };
    }

    const verdict = this.capVerdict(recipient.username);
    if (!verdict.allowed) {
      return { ok: false, reason: verdict.reason, to: recipient.username, title: recipient.title, text: null };
    }

    this.ctx.storage.sql.exec(`DELETE FROM pending_send`);
    this.ctx.storage.sql.exec(
      `INSERT INTO pending_send (id, to_text, to_label, text, prepared_at) VALUES (1, ?, ?, ?, ?)`,
      recipient.username,
      recipient.title,
      body,
      Date.now(),
    );
    return { ok: true, reason: null, to: recipient.username, title: recipient.title, text: body };
  }

  private readPending(): PendingSend | null {
    const rows = this.ctx.storage.sql
      .exec<{ to_text: string; to_label: string; text: string; prepared_at: number }>(
        `SELECT * FROM pending_send WHERE id = 1`,
      )
      .toArray();
    if (!rows.length) return null;
    const row = rows[0];
    return { to: row.to_text, toLabel: row.to_label, text: row.text, preparedAt: row.prepared_at };
  }

  /**
   * Sends whatever was last prepared. Takes no argument: the model's "yes" is a
   * second run that cannot carry an id it was never told, so the pending draft
   * is the only thing this can mean.
   */
  async sendPending(): Promise<SendResult> {
    const blocked = this.notConnectedReason();
    if (blocked) return { ok: false, reason: blocked, to: null, title: null };

    const pending = this.readPending();
    if (pendingSendExpired(pending, Date.now())) {
      this.ctx.storage.sql.exec(`DELETE FROM pending_send`);
      return {
        ok: false,
        reason: "That message is no longer waiting to go — ask me to send it again.",
        to: null,
        title: null,
      };
    }

    const verdict = this.capVerdict(pending!.to);
    if (!verdict.allowed) {
      return { ok: false, reason: verdict.reason, to: pending!.to, title: pending!.toLabel };
    }

    try {
      const sent = await this.withClient((client) =>
        client.sendMessage(pending!.to, { message: pending!.text }),
      );
      this.recordSend(pending!);
      if (sent && sent.className === "Message") {
        const line = this.storable(sent as Api.Message, new Map());
        if (line) {
          this.ctx.storage.sql.exec(
            `INSERT INTO messages (chat, message_id, chat_title, from_name, outgoing, text, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(chat, message_id) DO UPDATE SET text = excluded.text`,
            line.chat,
            line.messageId,
            pending!.toLabel,
            "you",
            1,
            line.text,
            line.sentAt,
          );
        }
      }
    } catch (error) {
      this.recordLoginError(error);
      const classified = classifyTelegramError(error, telegramErrorShape(error));
      return { ok: false, reason: classified.message, to: pending!.to, title: pending!.toLabel };
    }

    this.ctx.storage.sql.exec(`DELETE FROM pending_send`);
    return { ok: true, reason: null, to: pending!.to, title: pending!.toLabel };
  }

  /** Marks the recipient known and logs the send, so the caps can see it. */
  private recordSend(pending: PendingSend): void {
    const handle = pending.to.replace(/^@/, "");
    const now = Date.now();
    const cold = this.hasSentTo(handle) ? 0 : 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO recipients (username, title, first_sent_at) VALUES (?, ?, ?)
       ON CONFLICT(username) DO NOTHING`,
      handle,
      pending.toLabel,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO send_log (at, cold, chat) VALUES (?, ?, ?)`,
      now,
      cold,
      `user:${handle}`,
    );
  }

  private capVerdict(username: string): { allowed: boolean; reason: string | null } {
    const handle = username.replace(/^@/, "");
    const sentAt = this.ctx.storage.sql
      .exec<{ at: number }>(`SELECT at FROM send_log ORDER BY at ASC`)
      .toArray()
      .map((row) => row.at);
    const coldSentAt = this.ctx.storage.sql
      .exec<{ at: number }>(`SELECT at FROM send_log WHERE cold = 1 ORDER BY at ASC`)
      .toArray()
      .map((row) => row.at);

    return checkSendCaps({
      sentAt,
      coldSentAt,
      isCold: !this.hasSentTo(handle),
      now: Date.now(),
    });
  }
}

/** The name to show for a Telegram user, preferring the real name. */
function displayName(user: Api.User): string {
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.join(" ");
}

/**
 * Tells the classifier where this particular throw put the name and the number.
 *
 * `FloodWaitError` is the case that forces a helper: it reports `errorMessage`
 * as the bare `"FLOOD"` — the seconds are a typed field — so neither field alone
 * carries everything the classifier needs.
 */
function telegramErrorShape(error: unknown): {
  name: string | null;
  seconds: number | null;
} {
  if (error instanceof errors.FloodWaitError) {
    return { name: "FLOOD_WAIT", seconds: error.seconds };
  }
  return { name: null, seconds: null };
}
