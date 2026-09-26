/**
 * The voice agent: one Durable Object per signed-in user.
 *
 * It bridges two WebSockets — the browser's call page on one side and OpenAI's
 * GPT-Live session on the other — and runs the backend harness in between.
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
import { createToolRouterSession } from "./composio";
import type { Env } from "./env";
import { ConnectorHarness } from "./harness";
import { McpClient } from "./mcp";

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
/** How long a session may take to report itself started before the call gives up. */
const START_TIMEOUT_MS = 8000;
/** `WebSocket.readyState` for an open socket. */
const OPEN = 1;

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

export class VoiceAgent extends Agent<Env> {
  private live: WebSocket | null = null;
  private liveReady = false;
  private greeted = false;
  private transcript: TranscriptLine[] = [];
  private harness: ConnectorHarness | null = null;
  /** One backend task at a time; a second delegation while busy is dropped. */
  private busy = false;

  async onConnect(connection: Connection, _context: ConnectionContext): Promise<void> {
    try {
      // A socket can die without its close event ever reaching this object
      // (an idle session ended by OpenAI, a hibernation gap), so the field is
      // only trusted while the socket is actually open.
      if (this.live?.readyState !== OPEN) await this.openLiveSession();
      connection.send(JSON.stringify({ type: "call", state: this.liveReady ? "live" : "connecting" }));
    } catch (error) {
      console.error("voice agent: live session failed", error);
      connection.send(
        JSON.stringify({ type: "error", message: "We couldn't start the call. Please try again." }),
      );
    }
  }

  onMessage(_connection: Connection, message: WSMessage): void {
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

    if (control.type === "hangup") this.closeLiveSession();
  }

  onClose(): void {
    if ([...this.getConnections()].length === 0) this.closeLiveSession();
  }

  /* ----------------------------------------------------------- live session */

  private async openLiveSession(): Promise<void> {
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

    const response = await fetch(LIVE_SOCKET_URL, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
    });

    const socket = response.webSocket;
    if (!socket) throw new Error(`live session upgrade rejected (${response.status})`);

    socket.accept();
    socket.addEventListener("message", (event) => this.onLiveEvent(event.data));
    socket.addEventListener("close", () => this.onLiveClosed());
    socket.addEventListener("error", () => console.error("voice agent: live socket error"));

    this.live = socket;
    this.greeted = false;
    this.transcript = [];

    this.sendLive({
      type: "session.start",
      event_id: `start_${Date.now()}`,
      session: {
        model: LIVE_MODEL,
        instructions: conversationPrompt(),
        audio: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, output: { voice: VOICE } },
        delegation: { type: "client" },
        store: false,
      },
    });

    // Without a session the caller would sit on "Connecting" forever.
    setTimeout(() => {
      if (this.live === socket && !this.liveReady) {
        console.error("voice agent: session start timed out");
        this.broadcast(JSON.stringify({ type: "error", message: "The call didn't start. Please try again." }));
        this.onLiveClosed();
      }
    }, START_TIMEOUT_MS);
  }

  private closeLiveSession(): void {
    const socket = this.live;
    if (!socket) return;

    this.sendLive({ type: "session.close", event_id: `close_${Date.now()}` });
    setTimeout(() => {
      if (this.live === socket) this.onLiveClosed();
    }, CLOSE_TIMEOUT_MS);
  }

  private onLiveClosed(): void {
    this.live = null;
    this.liveReady = false;
    this.harness = null;
    this.broadcast(JSON.stringify({ type: "call", state: "ended" }));
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
        this.broadcast(JSON.stringify({ type: "call", state: "live" }));
        this.greet();
        break;

      case "session.output_audio.delta":
        this.broadcast(b64decode(String(event.delta ?? "")));
        break;

      case "session.input_transcript.delta":
        this.addTranscript("user", String(event.delta ?? ""));
        break;

      case "session.output_transcript.delta":
        this.addTranscript("assistant", String(event.delta ?? ""));
        break;

      case "session.delegation.created":
        void this.delegate(event);
        break;

      case "session.usage.updated":
        this.broadcast(JSON.stringify({ type: "usage", seconds: event.usage?.seconds ?? null }));
        break;

      case "session.closed":
        this.broadcast(
          JSON.stringify({ type: "call", state: "ended", seconds: event.usage?.seconds ?? null }),
        );
        this.onLiveClosed();
        break;

      case "error":
        console.error("voice agent: live error", JSON.stringify(event.error));
        this.broadcast(
          JSON.stringify({ type: "error", message: event.error?.message ?? "The call hit an error." }),
        );
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
        content:
          "Greet the caller in one short sentence: say you can help with their connected accounts, then stop and listen.",
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
    if (!this.live || !this.liveReady || length === 0) return;

    this.sendLive({
      type: "session.input_audio.append",
      audio: b64encode(length === bytes.length ? bytes : bytes.subarray(0, length)),
    });
  }

  /* ------------------------------------------------------------ delegation */

  private async delegate(event: Record<string, any>): Promise<void> {
    const delegationId = event.delegation?.id as string | undefined;
    if (!delegationId || this.busy) return;

    this.busy = true;
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
      const result = await harness.run(transcript, (note) => {
        this.broadcast(JSON.stringify({ type: "working", note }));
        this.sendLive({
          type: "session.thinking.append",
          event_id: `progress_${Date.now()}`,
          delegation_id: delegationId,
          content: note,
        });
      });

      this.sendLive({
        type: "session.commentary.append",
        event_id: `result_${Date.now()}`,
        delegation_id: delegationId,
        content: result.text,
      });
      this.broadcast(JSON.stringify({ type: "working", note: null }));
    } catch (error) {
      console.error("voice agent: harness failed", error);
      this.broadcast(JSON.stringify({ type: "error", message: "The connector lookup failed." }));
      this.sendLive({
        type: "session.commentary.append",
        event_id: `failed_${Date.now()}`,
        delegation_id: delegationId,
        content: "I couldn't reach the connected accounts just now. Please try that again.",
      });
    } finally {
      this.busy = false;
    }
  }

  private async getHarness(): Promise<ConnectorHarness> {
    if (this.harness) return this.harness;

    const session = await this.toolRouterSession();
    const harness = new ConnectorHarness(
      new McpClient(session.mcpUrl, this.env.COMPOSIO_API_KEY),
      this.env.DEEPSEEK_API_KEY,
      this.env.EXA_API_KEY,
      this.name,
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

    const last = this.transcript[this.transcript.length - 1];
    if (last?.role === role) last.text += delta;
    else this.transcript.push({ role, text: delta });

    this.broadcast(JSON.stringify({ type: "transcript", role, delta }));
  }

  private transcriptText(): string {
    return this.transcript
      .map((line) => `${line.role === "user" ? "Caller" : "Assistant"}: ${line.text.trim()}`)
      .join("\n")
      .slice(-4000);
  }

  private sendLive(payload: unknown): void {
    if (this.live?.readyState !== OPEN) return;
    this.live.send(JSON.stringify(payload));
  }
}

function conversationPrompt(): string {
  return `You are Ailobang's voice assistant, talking with someone who is signed in and has connected some of their accounts.

Tone: warm, brief, natural. Most replies are one or two sentences. Never read out markdown, lists or URLs.

Backend tools: the backend can read and act on the caller's connected accounts — Google (Gmail, Drive, Calendar, Sheets, Docs, Photos, Contacts, Tasks), Reddit, LinkedIn, Slack, Notion, Discord, Google Maps and Cursor. It can also search the live internet.

Delegate to the backend when:
- the request needs data from, or an action on, one of those accounts;
- the answer depends on news, current events, prices or anything that may have changed recently;
- a correction changes work already requested;
- the answer needs a lookup or careful reasoning.

Never answer a question about current events or the caller's own data from memory — the backend has the live sources and you do not.

Do not delegate for greetings, thanks, small talk, or anything you can already answer from the conversation.

Delegate before answering anything that depends on backend work, then keep the caller company briefly while it runs. Never say an account action happened unless the backend confirmed it. Never guess at private data.`;
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
