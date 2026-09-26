/**
 * The voice agent: one Durable Object per signed-in user.
 *
 * A call reaches it one of two ways. From the site, it bridges two WebSockets —
 * the browser's call page on one side and OpenAI's GPT-Live session on the other.
 * From a phone, Telnyx carries the audio to OpenAI over SIP, and this object
 * only attaches a sideband socket to the accepted session. Either way it runs
 * the backend harness in between.
 *
 * GPT-Live is configured for **client delegation**: it owns the spoken
 * conversation and decides when a request needs account data, but the reasoning
 * and every Composio MCP call happen here, in the harness. Delegations arrive as
 * `session.delegation.created`, which carries no task text, so the harness reads
 * the running transcript instead.
 */

import {
  Agent,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "agents";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { ChatRecorder, type ChatChannel } from "./chats";
import { CODE_TIMEOUT_MS } from "./code-tool";
import { createToolRouterSession } from "./composio";
import { DelegationQueue } from "./delegation-queue";
import type { Env } from "./env";
import { ConnectorHarness } from "./harness";
import { McpClient } from "./mcp";
import type { MemoryStore } from "./memory/memory-store";
import { PlaidBanks, plaidConfig } from "./plaid";

/**
 * The Live session socket. Workers reach a WebSocket with a plain https fetch
 * carrying `Upgrade: websocket`; a `wss://` URL is rejected outright.
 */
const LIVE_SOCKET_URL = "https://api.openai.com/v1/live/sessions";
const LIVE_MODEL = "gpt-live-1";
const VOICE = "marin";
const SAMPLE_RATE = 24000;
const SITE_ORIGIN = "https://ailobang.com";
const TOOL_ROUTER_KEY = "toolRouterSession";
/** Delegations arrive before the transcript is complete, so let it settle. */
const TRANSCRIPT_SETTLE_MS = 350;
/** GPT-Live normally ends the session itself; this backstops a silent socket. */
const CLOSE_TIMEOUT_MS = 15000;
/** How long a call survives with no connected caller, so a reload can resume it. */
const RECONNECT_GRACE_MS = 60000;
/** How long a session may take to report itself started before the call gives up. */
const START_TIMEOUT_MS = 8000;
/** How long the call start waits on long-term memory before going ahead without it. */
const BRIEF_TIMEOUT_MS = 1500;
/**
 * How many routed requests may wait behind the one being answered.
 *
 * Past this the answers would arrive too late to be about anything the caller
 * still remembers asking, and a short note is more use than the queue.
 */
const MAX_QUEUED_DELEGATIONS = 3;
/** `WebSocket.readyState` for an open socket. */
const OPEN = 1;
/**
 * How long a spoken line may sit unwritten.
 *
 * Lines arrive as deltas, many per second, so they are batched: a chat survives
 * a crash at the cost of at most this much of the end of the call.
 */
const CHAT_FLUSH_MS = 1200;
/** Connection tags: a call page's socket, or the live-call widget following along. */
const CALLER_TAG = "caller";
const WATCH_TAG = "watch";

export type CallChannel = ChatChannel;

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
  /** When the line started, so a stored transcript keeps its own times. */
  at: string;
}

export type PhoneAnswer = "accepted" | "busy" | "duplicate" | "failed";

export class VoiceAgent extends Agent<Env> {
  private live: WebSocket | null = null;
  private liveReady = false;
  private greeted = false;
  private harness: ConnectorHarness | null = null;
  /** Answers one delegation at a time, in the order they arrived. */
  private readonly delegations = new DelegationQueue(MAX_QUEUED_DELEGATIONS, (error) =>
    console.error("voice agent: delegation failed", error),
  );
  /** Pending teardown after the caller's last socket went away. */
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private opening = false;
  /**
   * The SIP session this object is attached to, while a phone call is on.
   *
   * The phone owns the call then: the browser can't send audio into it or hang
   * it up, and closing a tab doesn't end it.
   */
  private phoneSessionId: string | null = null;
  /** When this call began, for the record that is kept of it. */
  private callStartedAt: string | null = null;

  /* --------------------------------------------------------------- history */

  /**
   * The chat this call is being written to.
   *
   * Held in memory rather than in storage: a chat only matters while the call
   * that writes it is running, and a call that loses the object loses its
   * transcript anyway. The lines it holds are what the widget and the harness
   * read, so there is one copy of the conversation rather than two.
   */
  private chat: ChatRecorder | null = null;
  private chatFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the call is being ended on purpose, rather than having dropped. */
  private callEnding = false;

  /** Call-page sockets. The live-call widget's sockets only watch, and don't count. */
  private connectionCount(): number {
    return [...this.getConnections(CALLER_TAG)].length;
  }

  /** The widget's sockets, which must not be sent the call's audio. */
  private watcherIds(): string[] {
    return [...this.getConnections(WATCH_TAG)].map((connection) => connection.id);
  }

  getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    return new URL(context.request.url).searchParams.get("watch") === "1" ? [WATCH_TAG] : [CALLER_TAG];
  }

  /** Which call is on right now, if any: the widget shows it and the call page avoids it. */
  private channel(): CallChannel | null {
    if (this.live?.readyState !== OPEN || !this.liveReady) return null;
    return this.phoneSessionId ? "phone" : "site";
  }

  async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    // A watcher only follows along. It gets the call so far and then the same
    // transcript broadcasts as the call page, and never starts a session.
    if (connection.tags.includes(WATCH_TAG)) {
      connection.send(JSON.stringify({ type: "watch", channel: this.channel(), lines: this.chat?.spoken ?? [] }));
      return;
    }

    // A caller returning within the grace window resumes the call in flight.
    // A call that was hung up has already had its chat closed, so coming back
    // after one is a new call rather than a reconnection to an old one.
    const returning = this.teardownTimer !== null && this.chat !== null;
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }

    if (this.onPhone()) {
      connection.send(
        JSON.stringify({
          type: "error",
          message: "You're on a phone call with Ailobang right now. Hang up the phone to call from here.",
        }),
      );
      return;
    }

    try {
      // A socket can die without its close event ever reaching this object
      // (an idle session ended by OpenAI, a hibernation gap), so the field is
      // only trusted while the socket is actually open.
      const starting = this.live?.readyState !== OPEN;
      // A call that is not being picked up again is a new one, and it either
      // continues the chat the page asked for or opens a fresh one.
      if (!returning && starting) await this.beginCall("site", new URL(context.request.url).searchParams.get("chat"));
      if (starting) await this.openLiveSession();
      console.log("voice agent: caller connected", JSON.stringify({ connections: this.connectionCount(), liveReady: this.liveReady }));
      connection.send(JSON.stringify({ type: "call", state: this.liveReady ? "live" : "connecting" }));
      connection.send(
        JSON.stringify({
          type: "chat",
          id: this.chat?.id ?? null,
          resumed: (this.chat?.resumed.length ?? 0) > 0,
        }),
      );
    } catch (error) {
      console.error("voice agent: live session failed", error);
      connection.send(
        JSON.stringify({ type: "error", message: "We couldn't start the call. Please try again." }),
      );
    }
  }

  onMessage(connection: Connection, message: WSMessage): void {
    if (this.onPhone() || connection.tags.includes(WATCH_TAG)) return;

    if (typeof message !== "string") {
      this.appendAudio(toBytes(message));
      return;
    }

    let control: { type?: string };
    try {
      control = JSON.parse(message) as { type?: string };
    } catch {
      return;
    }

    if (control.type === "hangup") this.closeLiveSession("caller hung up");
    // "ping" needs no reply: it exists so the caller's socket is never idle.
  }

  onClose(connection: Connection): void {
    if (connection.tags.includes(WATCH_TAG)) return;
    const remaining = this.connectionCount();
    console.log("voice agent: caller disconnected", JSON.stringify({ remaining }));
    if (remaining > 0 || this.onPhone()) return;

    // Do not end the call the instant the socket drops. A reload, a sleeping
    // laptop or a network blip should resume the conversation, not kill it.
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = null;
      if (this.connectionCount() !== 0) return;
      // The live socket can already be gone — the call dropped and the caller
      // never came back — in which case there is nothing left to close, but the
      // chat is still open and has to be finished.
      this.callEnding = true;
      this.closeLiveSession("caller never came back");
      this.finishChat();
    }, RECONNECT_GRACE_MS);
  }

  /* ----------------------------------------------------------- live session */

  private async openLiveSession(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      await this.startLiveSession();
    } finally {
      this.opening = false;
    }
  }

  private async startLiveSession(): Promise<void> {
    // Replace rather than reuse: an object can hold a socket that is already dead.
    const previous = this.live;
    this.live = null;
    this.liveReady = false;
    if (previous && previous.readyState === OPEN) {
      try {
        previous.close();
      } catch (error) {
        console.error("voice agent: closing stale socket failed", error);
      }
    }

    const [socket, brief] = await Promise.all([this.connectLive(LIVE_SOCKET_URL), this.memoryBrief()]);
    this.bindLive(socket);

    this.sendLive({
      type: "session.start",
      event_id: `start_${Date.now()}`,
      session: {
        model: LIVE_MODEL,
        instructions: conversationPrompt("site", brief, this.chat?.resumePrompt() ?? ""),
        audio: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, output: { voice: VOICE } },
        delegation: { type: "client" },
        store: false,
      },
    });

    // Without a session the caller would sit on "Connecting" forever.
    setTimeout(() => {
      if (this.live === socket && !this.liveReady) {
        console.error("voice agent: session start timed out");
        this.notify({ type: "error", message: "The call didn't start. Please try again." });
        this.onLiveClosed("session start timed out");
      }
    }, START_TIMEOUT_MS);
  }

  /**
   * Answers a phone call OpenAI is holding for this user.
   *
   * The Worker has already matched the caller's number to this user. OpenAI
   * drops a pending SIP session within seconds, so this accepts first and
   * attaches after, and never waits on anything else in between.
   */
  async answerPhoneCall(sessionId: string): Promise<PhoneAnswer> {
    if (this.phoneSessionId === sessionId) return "duplicate";

    // One call at a time: the site call already holds the session and harness.
    if (this.live?.readyState === OPEN) {
      await this.liveCallAction(sessionId, "reject", { status_code: 486 });
      console.log("voice agent: phone call rejected, already on a call");
      return "busy";
    }

    const brief = await this.memoryBrief();
    // A phone call has no page behind it to name a chat, so it always starts a
    // new one. Opening it reads nothing before the accept below.
    await this.beginCall("phone", null);
    const accepted = await this.liveCallAction(sessionId, "accept", {
      session: {
        type: "live",
        model: LIVE_MODEL,
        instructions: conversationPrompt("phone", brief),
        audio: { output: { voice: VOICE } },
        delegation: { type: "client" },
        store: false,
      },
    });
    if (!accepted) return "failed";

    try {
      const socket = await this.connectLive(`${LIVE_SOCKET_URL}/${encodeURIComponent(sessionId)}/attach`);
      this.phoneSessionId = sessionId;
      this.bindLive(socket);
      this.liveReady = true;
      console.log("voice agent: phone call attached");
      this.notify({ type: "call", state: "live", channel: "phone" });
      this.greet();
      return "accepted";
    } catch (error) {
      // An accepted call with nothing attached would talk but never reach the
      // accounts, so end it rather than leave the caller with half an assistant.
      console.error("voice agent: phone attach failed", error);
      this.phoneSessionId = null;
      await this.liveCallAction(sessionId, "hangup");
      return "failed";
    }
  }

  private onPhone(): boolean {
    return this.phoneSessionId !== null && this.live?.readyState === OPEN;
  }

  /** accept, reject or hangup on a SIP session. Returns whether OpenAI took it. */
  private async liveCallAction(sessionId: string, action: "accept" | "reject" | "hangup", body?: unknown): Promise<boolean> {
    const response = await fetch(`${LIVE_SOCKET_URL}/${encodeURIComponent(sessionId)}/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) return true;

    console.error(
      `voice agent: phone ${action} failed`,
      JSON.stringify({ status: response.status, body: (await response.text()).slice(0, 500) }),
    );
    return false;
  }

  /**
   * Opens a Live socket. Workers reach a WebSocket with a plain https fetch
   * carrying `Upgrade: websocket`.
   */
  private async connectLive(url: string): Promise<WebSocket> {
    const response = await fetch(url, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error(`live session upgrade rejected (${response.status})`);
    socket.accept();
    return socket;
  }

  private bindLive(socket: WebSocket): void {
    socket.addEventListener("message", (event) => this.onLiveEvent(event.data));
    socket.addEventListener("close", (event) => {
      console.log(
        "voice agent: live socket closed",
        JSON.stringify({ code: (event as CloseEvent).code, clean: (event as CloseEvent).wasClean }),
      );
      if (this.live === socket) this.onLiveClosed("live socket closed");
    });
    socket.addEventListener("error", () => console.error("voice agent: live socket error"));

    this.live = socket;
    this.greeted = false;
    this.callStartedAt = new Date().toISOString();
  }

  private closeLiveSession(reason: string): void {
    const socket = this.live;
    if (!socket) return;

    console.log("voice agent: closing live session", JSON.stringify({ reason }));
    // Asked for, so the call is over rather than dropped and waiting to resume.
    this.callEnding = true;
    this.sendLive({ type: "session.close", event_id: `close_${Date.now()}` });
    setTimeout(() => {
      if (this.live === socket) this.onLiveClosed(`close timed out (${reason})`);
    }, CLOSE_TIMEOUT_MS);
  }

  private onLiveClosed(reason: string): void {
    const callerStillHere = this.connectionCount() > 0;
    console.log(
      "voice agent: session ended",
      JSON.stringify({ reason, callerStillHere, phone: this.phoneSessionId !== null }),
    );
    this.notify({ type: "call", state: "ended", reason });
    // The call is over: what it leaves in long-term memory is decided now, off
    // the call's path, from the whole conversation and everything the tools did.
    // It reads the chat, so it runs before the chat is closed and cleared.
    this.keepMemory("call", this.harness?.allWork() ?? null, true);
    // The phone owns its call and has no way back in, so its end is the call's
    // end. A site call that merely lost its live socket waits for the caller,
    // who can still be reconnected and carried on with.
    if (this.callEnding || this.phoneSessionId) this.finishChat();
    this.callEnding = false;
    this.live = null;
    this.liveReady = false;
    this.harness = null;
    this.phoneSessionId = null;
  }

  /* ---------------------------------------------------------------- memory */

  /** This user's memory object, or null when no Atlas is configured. */
  private memory(): DurableObjectStub<MemoryStore> | null {
    if (!this.env.MONGODB_URI) return null;
    return this.env.MEMORY_STORE.get(this.env.MEMORY_STORE.idFromName(this.name));
  }

  /**
   * What long-term memory says about the caller, for the session's
   * instructions. Bounded: a call must start whether or not Atlas answers.
   */
  private async memoryBrief(): Promise<string> {
    const memory = this.memory();
    if (!memory) return "";
    try {
      const brief = await Promise.race([
        memory.brief(),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), BRIEF_TIMEOUT_MS)),
      ]);
      return brief;
    } catch (error) {
      console.error("voice agent: memory brief failed", error);
      return "";
    }
  }

  /**
   * Hands the conversation so far to the memory object, which decides with Jev
   * whether anything is worth keeping and writes it. Runs in the background.
   */
  private keepMemory(source: "call" | "delegation", work: string | null, saveCall = false): void {
    const memory = this.memory();
    const conversation = this.transcriptText();
    if (!memory || !conversation) return;
    const startedAt = this.callStartedAt;

    this.ctx.waitUntil(
      (async () => {
        try {
          if (saveCall) {
            await memory.saveCall({ source, transcript: conversation, work, startedAt, endedAt: new Date().toISOString() });
          }
          const result = await memory.consolidate({ source, conversation, work });
          console.log("voice agent: memory", JSON.stringify({ source, ...result }));
          if (result.applied.length) this.notify({ type: "memory", applied: result.applied, route: result.route });
        } catch (error) {
          console.error("voice agent: memory pass failed", error);
        }
      })(),
    );
  }

  /**
   * Tells the open pages about the call. While the phone has it, only the
   * widget hears: a call page there has no call of its own to update.
   */
  private notify(message: Record<string, unknown>): void {
    this.broadcast(JSON.stringify(message), this.phoneSessionId ? this.callerIds() : undefined);
  }

  private callerIds(): string[] {
    return [...this.getConnections(CALLER_TAG)].map((connection) => connection.id);
  }

  private onLiveEvent(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);

    let event: Record<string, any>;
    try {
      event = JSON.parse(text) as Record<string, any>;
    } catch {
      return;
    }

    switch (event.type) {
      case "session.started":
        this.liveReady = true;
        this.notify({ type: "call", state: "live", channel: this.phoneSessionId ? "phone" : "site" });
        this.greet();
        break;

      case "session.output_audio.delta":
        // On a phone call this is the sideband's copy of what SIP already
        // played; an open call page must not play it a second time.
        if (!this.phoneSessionId) this.broadcast(b64decode(String(event.delta ?? "")), this.watcherIds());
        break;

      case "session.input_transcript.delta":
        this.addTranscript("user", String(event.delta ?? ""));
        break;

      case "session.output_transcript.delta":
        this.addTranscript("assistant", String(event.delta ?? ""));
        break;

      case "session.delegation.created":
        this.delegate(event);
        break;

      case "session.usage.updated":
        this.notify({ type: "usage", seconds: event.usage?.seconds ?? null });
        break;

      case "session.closed":
        this.notify({ type: "call", state: "ended", seconds: event.usage?.seconds ?? null });
        this.callEnding = true;
        this.onLiveClosed("gpt-live ended the session");
        break;

      case "error":
        console.error("voice agent: live error", JSON.stringify(event.error));
        this.notify({ type: "error", message: event.error?.message ?? "The call hit an error." });
        break;

      default:
        break;
    }
  }

  /** Once the session is live, have the assistant open the conversation. */
  private greet(): void {
    if (this.greeted) return;
    this.greeted = true;

    // Appends are only acknowledged while input audio is flowing, so the
    // greeting waits a beat for the browser's microphone stream to arrive.
    // The instruction alone is not reliably acted on, so it is followed by the
    // prompt the docs pair it with.
    setTimeout(() => {
      const eventId = Date.now();
      this.sendLive({
        type: "session.instructions.append",
        event_id: `greet_${eventId}`,
        delegation_id: null,
        content: this.chat?.resumed.length
          ? "Greet the caller in one short sentence, then carry on from where the earlier conversation left off."
          : "Greet the caller in one short sentence: say you can help with their connected accounts, then stop and listen.",
      });
      this.sendLive({
        type: "session.commentary.append",
        event_id: `greet_prompt_${eventId}`,
        delegation_id: null,
        content: "Begin the conversation now, following the instructions provided.",
      });
    }, 400);
  }

  private appendAudio(bytes: Uint8Array): void {
    // PCM16: an odd trailing byte would desync the stream, so it is dropped.
    const length = bytes.length - (bytes.length % 2);
    if (length === 0) return;

    // The Live socket can vanish without a close event reaching us (an eviction,
    // a dropped upstream). Audio arriving is the cue that the call is still on,
    // so bring the session back rather than swallowing the caller's speech.
    if (this.live?.readyState !== OPEN) {
      if (!this.opening) {
        console.log("voice agent: audio arrived with no live session, reopening");
        void this.openLiveSession().catch((error) => console.error("voice agent: reopen failed", error));
      }
      return;
    }

    this.sendLive({
      type: "session.input_audio.append",
      audio: b64encode(length === bytes.length ? bytes : bytes.subarray(0, length)),
    });
  }

  /* ------------------------------------------------------------ delegation */

  /**
   * Queues one delegated request behind any that is still running.
   *
   * GPT-Live expects an answer to every delegation it creates, and it can create
   * one while the backend is still on the last — the caller interrupts,
   * corrects themselves, or asks the next thing. Letting the new one wait rather
   * than dropping it is what keeps the caller from being met with silence; the
   * transcript is cumulative, so a run that starts later still sees the answer to
   * the earlier request and whatever the caller said over it.
   */
  private delegate(event: Record<string, any>): void {
    const delegationId = event.delegation?.id as string | undefined;
    if (!delegationId) return;

    const queued = this.delegations.add(() => this.answer(delegationId));
    if (!queued) {
      this.note(
        delegationId,
        "I'm still working through the last few things. Ask me again in a moment.",
      );
    }
  }

  /** Says something back about a delegation without running the backend. */
  private note(delegationId: string, content: string): void {
    this.sendLive({
      type: "session.commentary.append",
      event_id: `note_${Date.now()}`,
      delegation_id: delegationId,
      content,
    });
  }

  private async answer(delegationId: string): Promise<void> {
    try {
      await sleep(TRANSCRIPT_SETTLE_MS);
      const transcript = this.transcriptText();
      if (!transcript) return;

      this.sendLive({
        type: "session.thinking.append",
        event_id: `ack_${Date.now()}`,
        delegation_id: delegationId,
        content: "Checking the caller's connected accounts.",
      });

      const harness = await this.getHarness();
      // Step notes go to the page only: GPT-Live speaks the thinking it is
      // handed, and by the time it does, the step it names is long finished.
      const result = await harness.run(transcript, (note) => {
        this.notify({ type: "working", note });
      });

      this.sendLive({
        type: "session.commentary.append",
        event_id: `result_${Date.now()}`,
        delegation_id: delegationId,
        content: result.text,
      });
      this.notify({ type: "working", note: null });
      // Jev looks at every turn, not only ones that used tools: a preference can
      // land without a job, and a one-step job (a LinkedIn post, a Telegram) is
      // still a workflow worth keeping.
      this.keepMemory("delegation", harness.lastWork());
    } catch (error) {
      console.error("voice agent: harness failed", error);
      this.notify({ type: "error", message: "The connector lookup failed." });
      this.note(delegationId, "I couldn't reach the connected accounts just now. Please try that again.");
    }
  }

  private async getHarness(): Promise<ConnectorHarness> {
    if (this.harness) return this.harness;

    const session = await this.toolRouterSession();
    const plaid = plaidConfig(this.env);
    const harness = new ConnectorHarness(
      new McpClient(session.mcpUrl, this.env.COMPOSIO_API_KEY),
      this.env.DEEPSEEK_API_KEY,
      this.env.EXA_API_KEY,
      this.name,
      // The caller's own Telegram object, under the same name this agent is:
      // the session id the cookie carries is the name of both.
      this.env.TELEGRAM_SESSION.get(this.env.TELEGRAM_SESSION.idFromName(this.name)),
      new DynamicWorkerExecutor({ loader: this.env.LOADER, timeout: CODE_TIMEOUT_MS }),
      plaid ? new PlaidBanks(plaid, this.env.DB, this.name) : null,
      this.memory(),
    );
    await harness.warmUp();

    this.harness = harness;
    return harness;
  }

  /** One Composio session per user, created on demand and reused for later calls. */
  private async toolRouterSession(): Promise<{ sessionId: string; mcpUrl: string }> {
    const cached = await this.ctx.storage.get<{ sessionId: string; mcpUrl: string }>(TOOL_ROUTER_KEY);
    if (cached?.mcpUrl) return cached;

    const created = await createToolRouterSession(
      this.env.COMPOSIO_API_KEY,
      this.name,
      `${SITE_ORIGIN}/connect/return`,
    );
    await this.ctx.storage.put(TOOL_ROUTER_KEY, created);
    return created;
  }

  /* --------------------------------------------------------------- plumbing */

  private addTranscript(role: TranscriptLine["role"], delta: string): void {
    if (!delta) return;
    this.chat?.addLine(role, delta);
    this.notify({ type: "transcript", role, delta });
    this.scheduleChatFlush();
  }

  /**
   * The conversation so far, including whatever an earlier call left behind.
   *
   * A continued call starts with an empty transcript, so without the earlier
   * lines "and send that to him" would reach the harness with no "that" in it.
   */
  private transcriptText(): string {
    return this.chat?.text() ?? "";
  }

  /* ----------------------------------------------------------------- chats */

  /**
   * Starts writing the call to a chat: the one the page named, or a new one.
   *
   * A chat the caller does not own reads as no chat at all, so a stale link
   * still gets them a working call.
   */
  private async beginCall(channel: ChatChannel, requested: string | null): Promise<void> {
    const chat = new ChatRecorder({ db: this.env.DB, userId: this.name, channel, resumeId: requested });
    await chat.load();
    this.chat = chat;
    console.log("voice agent: call chat", JSON.stringify({ chat: chat.id, continues: chat.continues }));
  }
  private scheduleChatFlush(): void {
    if (this.chatFlushTimer) return;
    this.chatFlushTimer = setTimeout(() => {
      this.chatFlushTimer = null;
      // Nothing is waiting on this: lines arrive on a socket message, and the
      // call has to keep carrying audio while the write goes out.
      void this.flushChat();
    }, CHAT_FLUSH_MS);
  }

  /**
   * Writes the lines spoken since the last flush.
   *
   * A failed write is logged and swallowed: losing history must never cost a
   * call. The recorder chains the writes itself, so two cannot race.
   */
  private async flushChat(chat = this.chat): Promise<void> {
    if (!chat) return;
    try {
      const { opened } = await chat.flush();
      // A page that continued an earlier call already has the id in its URL;
      // only a chat that started here needs telling.
      if (opened && !chat.continues) this.notify({ type: "chat", id: chat.id });
    } catch (error) {
      console.error("voice agent: writing the chat failed", error);
    }
  }

  /** Closes the chat at the end of a call. Only the first caller closes it. */
  private finishChat(chat = this.chat): void {
    this.chat = null;
    if (!chat) return;
    if (this.chatFlushTimer) {
      clearTimeout(this.chatFlushTimer);
      this.chatFlushTimer = null;
    }
    // Nothing is waiting on this: the call is already over, and the write has
    // to outlive the event that started it.
    void this.ctx
      .waitUntil(chat.finish().catch((error) => console.error("voice agent: closing the chat failed", error)));
  }

  private sendLive(payload: unknown): void {
    if (this.live?.readyState !== OPEN) return;
    this.live.send(JSON.stringify(payload));
  }
}

function conversationPrompt(channel: "site" | "phone", brief = "", earlier = ""): string {
  const opening =
    channel === "phone"
      ? "You are Ailobang's voice assistant, on a phone call with someone who dialled in from the number linked to their account, which has some of their accounts connected."
      : "You are Ailobang's voice assistant, talking with someone who is signed in and has connected some of their accounts.";

  const memory = brief
    ? `What you already know about the caller, from long-term memory built up over earlier calls. It is true unless they correct it; use it naturally and never ask for what is already here:
${brief}

The backend keeps this memory. When the caller tells you to remember or forget something, delegate so it is saved; memory also updates itself after each call, so do not announce that you are memorising things.`
    : "You have no long-term memory of this caller yet. The backend will start building one from this call; when the caller tells you to remember something, delegate so it is saved.";

  return `${opening}

${memory}
${earlier ? `\n${earlier}\n` : ""}
Tone: warm, brief, natural. Most replies are one or two sentences. Never read out markdown, lists or URLs.

Backend tools: the backend can read and act on the caller's connected accounts — Google (Gmail, Drive, Calendar, Sheets, Docs, Photos, Contacts, Tasks), Telegram, Reddit, LinkedIn, Slack, Notion, Discord, Google Maps, Cursor, and the bank accounts they linked through Plaid (balances and transactions, read-only). It can also search the live internet.

That is what the backend is able to do, not a list of what is connected. Never say that an account is or is not connected, and never name what they have connected, from memory or from that list: the backend is the only thing that knows, so delegate and let its answer be what you say. Never tell the caller they have not connected something without having asked the backend in this call.

Asking is the go-ahead. When the caller asks you to send a message, make a document or do anything else on their accounts, delegate it straight away and let the backend do it in one go. Never ask "shall I send it?", never offer to send once they say yes, and never read a message back for approval. The backend acts on the first request, and only asks back when something is genuinely unclear.

When the backend says something is done, it is done: say so plainly and do not describe it as still in progress. When the caller asks whether something happened, delegate and let the backend answer from what it actually did.

Telegram is by name: a person's name is enough, so never ask the caller for a username or handle. The backend resolves the name. A contact with no public username can still be messaged, so never tell the caller a handle is needed. If a name fits more than one person the backend will come back and ask which one, so never guess.

Delegate to the backend when:
- the request needs data from, or an action on, one of those accounts;
- the answer depends on news, current events, prices or anything that may have changed recently;
- a correction changes work already requested;
- the answer needs a lookup or careful reasoning.

Never answer a question about current events or the caller's live account data from your own knowledge — the backend has the live sources and you do not. What is written above under long-term memory is different: that is known, and you may use it.

Do not delegate for greetings, thanks, small talk, or anything you can already answer from the conversation.

Delegate before answering anything that depends on backend work, then keep the caller company briefly while it runs, with one short line rather than a running commentary. Never say an account action happened unless the backend confirmed it. Never guess at private data.`;
}

function toBytes(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
