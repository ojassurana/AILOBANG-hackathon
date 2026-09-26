/**
 * One Durable Object per user, holding that user's own Telegram account.
 *
 * This is a **user session**, not a bot: the caller logs in with their phone
 * number and Telegram issues a session for their real account. There is no
 * read-only scope for such a session, which is why the caps and the repeat-send
 * guard in `telegram-session.ts` exist.
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
import { Api, TelegramClient, errors, utils } from "teleproto";
import { StringSession } from "teleproto/sessions";
import type { Env } from "./env";
import {
  type ContactCandidate,
  type NamedPerson,
  addressUserId,
  freshIdentity,
  rankMatches,
  resolveSpokenName,
  sendAddress,
  sendKey,
  spokenAddress,
  storedPeople,
} from "./telegram-contacts";
import {
  REPEAT_SEND_WINDOW_MS,
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
  repeatSentAt,
  restartLogin,
} from "./telegram-session";
import { password as passwordHelper } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { Buffer } from "node:buffer";
import {
  MAX_FILE_BYTES,
  type OutgoingFile,
  type SettledFile,
  fileFingerprint,
  fileNameFor,
  settleFile,
  tooBig,
} from "./telegram-files";

/**
 * How much of the conversation we keep. Both limits are deliberately small: the
 * point of reading forward from connection is to speak to what is happening now,
 * and keeping a long archive would turn a live view into a history store.
 */
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_MESSAGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Pages of `getDifference` to walk before giving up on catching up. */
const MAX_DIFFERENCE_PAGES = 20;
/** How many people one `contacts.Search` may offer for a spoken name. */
const CONTACT_SEARCH_LIMIT = 20;
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
  /** The @handle to send to, or null when the account has none and the id is used. */
  username: string | null;
  /** The account's Telegram id, which is what a username-less send is addressed by. */
  userId: string | null;
  title: string;
  /** Whether we have never sent to this person, which is the risky case. */
  cold: boolean;
}

export interface SendResult {
  /** False when nothing went out, with `reason` saying why. */
  ok: boolean;
  reason: string | null;
  /** The @handle it went to, or null when the account has no handle to name. */
  to: string | null;
  title: string | null;
  /** Exactly the text that went out. */
  text: string | null;
  /**
   * Set when this exact message had already gone to this person moments ago,
   * so it was not sent again: when that earlier send happened.
   */
  alreadySentAt: number | null;
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
      this.restoreConnectedAfterRequestError();
    });
  }

  /**
   * Undoes the one way a working login used to end up in the error phase: a
   * failed send recorded as a login failure. Such a row still has its session
   * and the update line, and no code hash — a login that failed before
   * finishing always has a hash, or no session at all.
   */
  private restoreConnectedAfterRequestError(): void {
    const row = this.readLogin();
    if (row.phase !== "error" || !row.session || row.phone_code_hash) return;
    if (!this.readUpdatesState()) return;
    this.writeLogin(loginConnected(row.code_sent_at ?? Date.now(), row.phone));
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
    // Created by earlier versions for a draft awaiting a yes; nothing reads it now.
    sql.exec(`DROP TABLE IF EXISTS pending_send`);
    /** What went to whom lately, so a repeated request does not send twice. */
    sql.exec(`CREATE TABLE IF NOT EXISTS recent_sends (
      send_key TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
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
    sql.exec(`DELETE FROM recent_sends`);
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
      // The number the user typed, or the one Telegram reports for its own
      // account when the login never kept it — an account with no @username is
      // otherwise left with nothing to identify it by.
      const phone = this.loginState().phone ?? me.user?.phone ?? null;
      this.writeLogin(loginConnected(Date.now(), phone), {
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
    // A connected account whose session still works stays connected: a refused
    // photo, a flood wait or a dropped socket is about that one request, and
    // recording it as a login failure would read everywhere as "not connected".
    if (this.readLogin().phase === "connected") {
      console.error("telegram: request failed on a live session", error);
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
        await this.refillIdentity(client);
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
   * Fills in a missing identifier on the stored login, using the one moment a
   * connection is already open.
   *
   * A login that finished before the phone was kept has a session but nothing to
   * name it by, which is what the connected row and the step screen show. Asking
   * mid-sync repairs it without a socket of its own. Telegram sends a number only
   * for the caller's own account, so a call that comes back without one is not a
   * failure: the row simply keeps showing what it already has.
   */
  private async refillIdentity(client: TelegramClient): Promise<void> {
    const row = this.readLogin();
    if (row.phone && row.username) return;

    try {
      const me = await client.getMe();
      const username = me.username ?? row.username;
      const phone = row.phone ?? me.phone ?? null;
      if (username === row.username && phone === row.phone) return;
      this.writeLogin({ ...this.loginState(), phone }, { username });
    } catch (error) {
      console.error("telegram: could not read the account's own identity", error);
    }
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
   * The people the caller might mean by a spoken name, best first.
   *
   * Three sources, stopping at the first that knows the name. The stored chats
   * cost nothing and a hit there means the person has actually written to the
   * caller, so they come first; the account's own address book is next, and
   * Telegram's own search is the last resort for someone never spoken to. Only
   * matches for the name asked about are returned — the address book itself is
   * fetched, used and dropped, never stored. Each match carries the id and access
   * hash it came with, which is what lets a contact with no @username be sent
   * to; the hash is not written anywhere on the way.
   *
   * Nothing comes back on an unconnected account. An empty list and "not
   * connected" are different answers, so every caller refuses on the connection
   * first rather than reading this as "nobody is called that".
   */
  async findContacts(spoken: string): Promise<ContactCandidate[]> {
    const query = spoken.replace(/^@/, "").trim();
    if (!query) return [];
    if (this.notConnectedReason()) return [];

    const stored = rankMatches(this.storedPeople(), query, "chat");
    if (stored.length) return stored;

    return this.withClient(async (client) => {
      const known = rankMatches(peopleFrom(await client.getContacts()), query, "contacts");
      if (known.length) return known;

      const found = await client.invoke(
        new Api.contacts.Search({ q: query, limit: CONTACT_SEARCH_LIMIT }),
      );
      return rankMatches(peopleFrom(found.users), query, "search");
    });
  }

  /**
   * The names in the messages table, which is the one source that needs no
   * socket. Only the rows are read here; reading them is the module's business,
   * and the chat key is where the id comes from — there is no hash in this table
   * to recover in the first place.
   */
  private storedPeople(): NamedPerson[] {
    const rows = this.ctx.storage.sql
      .exec<{ chat: string; chat_title: string }>(
        `SELECT chat, chat_title, MAX(sent_at) AS last FROM messages
         WHERE chat_title IS NOT NULL
         GROUP BY chat
         ORDER BY last DESC`,
      )
      .toArray()
      .map((row) => ({ chat: row.chat, title: row.chat_title }));

    return storedPeople(rows);
  }

  /**
   * The person a `to` argument names, or what to tell the caller instead.
   *
   * A leading @ is taken at its word and resolved as a handle. Anything else is
   * a spoken name and goes through the lookup, which has to settle on exactly
   * one person; a name nobody in the account matches may still be a bare handle,
   * because the @ is optional when the caller says the handle itself.
   */
  private async recipientFor(typed: string): Promise<{ recipient: Recipient } | { reason: string }> {
    if (typed.startsWith("@")) {
      const recipient = await this.findRecipient(typed);
      return recipient ? { recipient } : { reason: `I couldn't find anyone with the username ${typed}.` };
    }

    const people = await this.findContacts(typed);
    if (!people.length) {
      const asHandle = await this.findRecipient(typed);
      if (asHandle) return { recipient: asHandle };
    }

    const settled = resolveSpokenName(typed, people);
    if (settled.kind === "refuse") return { reason: settled.reason };

    const target = settled.target;
    return {
      recipient: {
        username: target.username,
        userId: target.userId,
        title: target.title,
        cold: !this.hasSentTo(sendKey(sendAddress(target))),
      },
    };
  }

  /**
   * Looks a person up by handle. A handle is all the peer itself needs, so there
   * is no id to build here; the id that comes back with it is carried along
   * because the send tables key everyone the same way.
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

      const cold = !this.hasSentTo(sendKey(handle));
      return {
        username: user.username ? `@${user.username}` : `@${handle}`,
        userId: String(user.id),
        title: displayName(user) || (user.username ? `@${user.username}` : handle),
        cold,
      };
    });
  }

  /** Whether the send tables already know this key, which is what coldness means. */
  private hasSentTo(key: string): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM recipients WHERE username = ?`, key)
      .toArray();
    return (rows[0]?.n ?? 0) > 0;
  }

  /**
   * Resolves who `to` names and sends them the message, in one call.
   *
   * The caller asking is the go-ahead, so nothing waits for a second yes. What
   * still stops a send: a name that fits more than one person, the caps, and
   * this exact text having gone to this person moments ago — the request is
   * re-read on every turn of a call, and "send it" said twice is one message.
   *
   * A handle addresses the peer on its own. A user id does not: it needs an
   * access hash, and this is where that hash is obtained — by looking the id up
   * again, in the same call as the send itself. Nothing in storage holds a hash,
   * so there is none to go stale.
   */
  async send(to: string, text: string): Promise<SendResult> {
    const body = text.trim();
    if (!body) return refusedSend("There was no message to send.");

    return this.deliver(to, body, body, async () => (client, peer) =>
      client.sendMessage(peer, { message: body }),
    );
  }

  /**
   * Sends a file — a photo, a video, a voice note, any document — the same way
   * `send` sends text: one call, the same recipient lookup, the same caps, and
   * the same file to the same person moments later is reported rather than sent
   * twice. A link is downloaded here rather than handed to Telegram, because
   * the signed links other tools return are not ones Telegram's servers fetch.
   */
  async sendFile(to: string, file: OutgoingFile): Promise<SendResult> {
    const settled = settleFile(file ?? {});
    if ("reason" in settled) return refusedSend(settled.reason);

    const fingerprint = fileFingerprint(settled, settled.filename ?? "");
    let shownName = settled.filename ?? "file";

    return this.deliver(to, fingerprint, () => `[${shownName}] ${settled.caption}`.trim(), async () => {
      const loaded = await this.loadFile(settled);
      if ("reason" in loaded) return loaded;
      shownName = loaded.name;

      const upload = () =>
        new CustomFile(loaded.name, loaded.bytes.byteLength, "", Buffer.from(loaded.bytes));
      const sendAs = (client: TelegramClient, peer: string | Api.InputPeerUser, forceDocument: boolean) =>
        client.sendFile(peer, {
          file: upload(),
          caption: settled.caption || undefined,
          forceDocument,
          voiceNote: settled.mode === "voice",
          supportsStreaming: true,
          // Each worker is a media socket of its own; a few is plenty for 20 MB.
          workers: 4,
        });

      return async (client, peer) => {
        const asDocument = settled.mode === "document";
        try {
          return await sendAs(client, peer, asDocument);
        } catch (error) {
          // Telegram will not make a photo of every image it is given (odd
          // dimensions, an encoding it dislikes); the same bytes still go as a file.
          if (asDocument || !isPhotoRefusal(error)) throw error;
          return sendAs(client, peer, true);
        }
      };
    });
  }

  /** The bytes and final name of a settled file, fetching a link when that is the source. */
  private async loadFile(
    file: SettledFile,
  ): Promise<{ bytes: Uint8Array; name: string } | { reason: string }> {
    if (file.source.kind === "bytes") {
      return { bytes: file.source.bytes, name: fileNameFor(file.filename, file.source.mimeType, null) };
    }

    const url = file.source.url;
    let response: Response;
    try {
      response = await fetch(url, { redirect: "follow" });
    } catch (error) {
      return { reason: `The file link could not be reached (${String(error).slice(0, 120)}), so nothing was sent.` };
    }
    if (!response.ok) {
      return { reason: `The file link answered ${response.status}, so nothing was sent; it may have expired.` };
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_FILE_BYTES) return { reason: tooBig(declared) };

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength) return { reason: "The file link returned an empty file, so nothing was sent." };
    if (bytes.byteLength > MAX_FILE_BYTES) return { reason: tooBig(bytes.byteLength) };

    return { bytes, name: fileNameFor(file.filename, response.headers.get("content-type"), url) };
  }

  /**
   * What every send shares: who `to` is, whether this has just gone to them,
   * the caps, the peer, and the record of it afterwards.
   *
   * `prepare` runs only once all of that has allowed the send, so a download is
   * never made for a message the caps would refuse, and it runs before the
   * socket opens, so no connection sits idle while a file comes in.
   */
  private async deliver(
    to: string,
    fingerprint: string,
    shown: string | (() => string),
    prepare: () => Promise<
      ((client: TelegramClient, peer: string | Api.InputPeerUser) => Promise<Api.Message>) | { reason: string }
    >,
  ): Promise<SendResult> {
    const blocked = this.notConnectedReason();
    if (blocked) return refusedSend(blocked);

    const settled = await this.recipientFor(to);
    if ("reason" in settled) return refusedSend(settled.reason);
    const recipient = settled.recipient;
    const address = sendAddress(recipient);
    const key = sendKey(address);
    const said = () => (typeof shown === "string" ? shown : shown());
    const done = (alreadySentAt: number | null): SendResult => ({
      ok: true,
      reason: null,
      to: spokenAddress(address),
      title: recipient.title,
      text: said(),
      alreadySentAt,
    });

    const repeat = repeatSentAt(this.recentSends(key), fingerprint, Date.now());
    if (repeat !== null) return done(repeat);

    const verdict = this.capVerdict(key);
    if (!verdict.allowed) return refusedSend(verdict.reason ?? "That can't be sent right now.", recipient.title);

    const sendWith = await prepare();
    if ("reason" in sendWith) return refusedSend(sendWith.reason, recipient.title);

    const userId = addressUserId(address);
    try {
      const sent = await this.withClient(async (client) => {
        if (userId === null) return sendWith(client, address);

        // The id is all the lookup kept, so the peer is built from the hash
        // this call fetches. A stored hash would address whoever it points at
        // now, which is why a failed lookup sends nothing instead.
        const peer = await this.peerForUserId(client, userId, recipient.title);
        return peer ? sendWith(client, peer) : null;
      });

      if (!sent) {
        return refusedSend(
          `Telegram isn't giving me ${recipient.title} to send to, so nothing was sent. Say that ` +
            `plainly: retrying the same name will not change it, and only an @username the caller ` +
            `knows would reach them.`,
          recipient.title,
        );
      }

      this.recordSend(address, recipient.title, fingerprint);
      if (sent.className === "Message") {
        const message = sent as Api.Message;
        const peer = message.peerId;
        if (peer && peer.className === "PeerUser") {
          this.ctx.storage.sql.exec(
            `INSERT INTO messages (chat, message_id, chat_title, from_name, outgoing, text, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(chat, message_id) DO UPDATE SET text = excluded.text`,
            `user:${String((peer as Api.PeerUser).userId)}`,
            Number(message.id),
            recipient.title,
            "you",
            1,
            said(),
            Number(message.date) * 1000,
          );
        }
      }
    } catch (error) {
      this.recordLoginError(error);
      const classified = classifyTelegramError(error, telegramErrorShape(error));
      return refusedSend(classified.message, recipient.title);
    }

    return done(null);
  }

  private recentSends(key: string): { text: string; at: number }[] {
    return this.ctx.storage.sql
      .exec<{ text: string; at: number }>(
        `SELECT text, at FROM recent_sends WHERE send_key = ? AND at > ?`,
        key,
        Date.now() - REPEAT_SEND_WINDOW_MS,
      )
      .toArray();
  }

  /**
   * The peer for a user id, built from an access hash this call just fetched.
   *
   * Contacts first, then Telegram search — the same lookups a spoken name goes
   * through, both of which carry the hash a peer needs, and both matched on the
   * id rather than on the name. A name nobody can be searched for exactly (the
   * caller's own label for a contact, say) is tried again on its first word;
   * widening the query cannot reach the wrong person, because every result is
   * still accepted only if its id is the one the name resolved to.
   *
   * Null when none of that knows the id, which sends nothing rather than
   * reaching for a hash from an earlier request.
   */
  private async peerForUserId(
    client: TelegramClient,
    userId: string,
    name: string,
  ): Promise<Api.InputPeerUser | null> {
    let identity = freshIdentity(userId, peopleFrom(await client.getContacts()));

    for (const query of searchTerms(name)) {
      if (identity) break;
      const found = await client.invoke(
        new Api.contacts.Search({ q: query, limit: CONTACT_SEARCH_LIMIT }),
      );
      identity = freshIdentity(userId, peopleFrom(found.users));
    }
    if (!identity) return null;

    // `Api.InputPeerUser` wants 64-bit values where every other id in this file
    // travels as a decimal string, and teleproto's own parser is the one way to
    // get them without a second big-integer dependency.
    const id = utils.parseID(identity.userId);
    const accessHash = utils.parseID(identity.accessHash);
    if (!id || !accessHash) return null;

    return new Api.InputPeerUser({ userId: id, accessHash });
  }

  /** Marks the recipient known and logs the send, so the caps and the repeat guard can see it. */
  private recordSend(address: string, title: string, text: string): void {
    const key = sendKey(address);
    const userId = addressUserId(address);
    const now = Date.now();
    const cold = this.hasSentTo(key) ? 0 : 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO recipients (username, title, first_sent_at) VALUES (?, ?, ?)
       ON CONFLICT(username) DO NOTHING`,
      key,
      title,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO send_log (at, cold, chat) VALUES (?, ?, ?)`,
      now,
      cold,
      `user:${userId ?? address.replace(/^@/, "")}`,
    );
    this.ctx.storage.sql.exec(`DELETE FROM recent_sends WHERE at <= ?`, now - REPEAT_SEND_WINDOW_MS);
    this.ctx.storage.sql.exec(`INSERT INTO recent_sends (send_key, text, at) VALUES (?, ?, ?)`, key, text, now);
  }

  private capVerdict(key: string): { allowed: boolean; reason: string | null } {
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
      isCold: !this.hasSentTo(key),
      now: Date.now(),
    });
  }
}

function isPhotoRefusal(error: unknown): boolean {
  const name = (error as { errorMessage?: unknown } | null)?.errorMessage;
  return typeof name === "string" && /^(IMAGE_PROCESS_FAILED|PHOTO_)/.test(name);
}

function refusedSend(reason: string, title: string | null = null): SendResult {
  return { ok: false, reason, to: null, title, text: null, alreadySentAt: null };
}

/** The name to show for a Telegram user, preferring the real name. */
function displayName(user: Api.User): string {
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.join(" ");
}

/**
 * The queries to search Telegram with for a stored name, in order.
 *
 * The whole name first, then its first word: a label the caller's own address
 * book gave someone may not be what Telegram's name index holds, and the first
 * word is the likeliest thing it does. Results are matched on the id, so the
 * wider second query cannot reach anyone else.
 */
function searchTerms(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const [first] = trimmed.split(/\s+/);
  return first && first !== trimmed ? [trimmed, first] : [trimmed];
}

/**
 * A 64-bit value as the decimal string the rest of this file passes around, or
 * null when there is nothing usable. Telegram answers with 0 for a hash it will
 * not let us address, and 0 is not an access hash.
 */
function longValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === "" || text === "0" ? null : text;
}

/**
 * The matchable part of a list of Telegram users.
 *
 * A deleted account and an empty slot name nobody, so they are dropped rather
 * than offered as a candidate. A user with no @username is kept, together with
 * the id and access hash the same response carried: they are a real answer to
 * the name asked about, and a message reaches their account without a handle.
 */
function peopleFrom(users: Api.TypeUser[]): NamedPerson[] {
  return users
    .filter((user): user is Api.User => user.className === "User")
    .filter((user) => !user.deleted)
    .map((user) => ({
      title: displayName(user) || (user.username ? `@${user.username}` : ""),
      username: user.username ? `@${user.username}` : null,
      userId: String(user.id),
      accessHash: longValue(user.accessHash),
    }))
    .filter((person) => person.title);
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
