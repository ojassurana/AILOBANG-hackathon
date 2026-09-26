/**
 * The Telegram tools the backend harness can call.
 *
 * Telegram is not a Composio toolkit, so it is absent from the meta-tools the
 * MCP session exposes: the connection is this app's own Durable Object, holding
 * the caller's real account rather than a bot. These four tools are the only way
 * the harness reaches it.
 *
 * They keep the promises the screens make. Reading is forward-only — the stored
 * messages begin at the login, so there is nothing older to return even by
 * accident. Sending is two calls, and the message goes out on the second one
 * only, after the caller has heard it read back and said yes; the object holds
 * exactly one prepared message so that "yes" can only mean the last one.
 */

import type { ToolSchema } from "./deepseek";
import type { ChatSummary, MessageLine, PrepareResult, SendResult, TelegramStatus } from "./telegram";

/** The part of `TelegramSession` these tools use. */
export interface TelegramActions {
  status(): Promise<TelegramStatus>;
  listChats(limit?: number): Promise<ChatSummary[]>;
  readMessages(chat: string, limit?: number): Promise<MessageLine[]>;
  prepareSend(to: string, text: string): Promise<PrepareResult>;
  sendPending(): Promise<SendResult>;
}

const LIST_CHATS = "telegram_list_chats";
const READ_MESSAGES = "telegram_read_messages";
const PREPARE_SEND = "telegram_prepare_send";
const CONFIRM_SEND = "telegram_confirm_send";

/** Telegram's own cap is far above this; a spoken answer cannot use more. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export const TELEGRAM_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: LIST_CHATS,
      description:
        "List the caller's own Telegram chats that have something in them since they connected, " +
        "most recent first, with how many messages are from the other person. Use this first for " +
        "any question about who has messaged them or what is new. Only what has arrived since they " +
        "connected exists; there is no older history to show.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: `How many chats to list. Defaults to ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: READ_MESSAGES,
      description:
        "Read the recent messages of one Telegram chat. Take the chat name from telegram_list_chats, " +
        "or pass the person's @username. Only messages that arrived since the caller connected are " +
        "stored, so an empty result means nothing has come in, not that history was hidden.",
      parameters: {
        type: "object",
        properties: {
          chat: {
            type: "string",
            description: "The chat to read: a name from telegram_list_chats, or the person's @username.",
          },
          limit: { type: "integer", description: `How many messages to read. Defaults to ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.` },
        },
        required: ["chat"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: PREPARE_SEND,
      description:
        "Prepare a Telegram message for the caller to confirm. This does NOT send anything. Give the " +
        "exact text so it can be read back to them; nothing goes out until they say yes and you call " +
        `telegram_confirm_send. Send to a person by their @username only.`,
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "The recipient's @username, e.g. @someone." },
          text: { type: "string", description: "The exact message text, as it will be sent." },
        },
        required: ["to", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: CONFIRM_SEND,
      description:
        "Send the Telegram message that telegram_prepare_send last prepared, once the caller has " +
        "heard it read back and said yes. Takes no arguments: it always means that prepared message, " +
        "which stops being available a couple of minutes after it was prepared. Call it once.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const TOOL_NAMES = new Set([LIST_CHATS, READ_MESSAGES, PREPARE_SEND, CONFIRM_SEND]);

export function isTelegramTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

/** Runs one Telegram tool and returns the text the model reasons over. */
export class TelegramToolbox {
  constructor(private readonly telegram: TelegramActions) {}

  handles(name: string): boolean {
    return isTelegramTool(name);
  }

  async run(name: string, rawArguments: string): Promise<string> {
    // Every one of these acts on a session, so none of them can answer anything
    // useful without one; the object would otherwise report an empty inbox,
    // which reads as "nobody has messaged you" rather than "not connected".
    const blocked = await this.connectionProblem();
    if (blocked) return blocked;

    switch (name) {
      case LIST_CHATS:
        return this.listChats(rawArguments);
      case READ_MESSAGES:
        return this.readMessages(rawArguments);
      case PREPARE_SEND:
        return this.prepareSend(rawArguments);
      case CONFIRM_SEND:
        return this.confirmSend();
      default:
        return `There is no Telegram tool called ${name}.`;
    }
  }

  private async connectionProblem(): Promise<string | null> {
    const status = await this.telegram.status();
    if (status.phase === "connected" && status.hasSession) return null;
    if (status.phase === "code" || status.phase === "password") {
      return (
        "The caller's Telegram login isn't finished, so there is nothing to read and nothing can " +
        "be sent yet. Tell them to finish entering their code on the Telegram page, on their accounts page."
      );
    }
    if (status.phase === "error") {
      return (
        `Telegram isn't usable right now: ${status.error ?? "the last attempt failed"}. Tell the caller ` +
        "that, and that they can start again from the Telegram row on their accounts page."
      );
    }
    return (
      "Telegram isn't connected on this account, so there are no messages to read and nowhere to " +
      "send from. Tell the caller to connect it from the Telegram row on their accounts page."
    );
  }

  private async listChats(rawArguments: string): Promise<string> {
    const args = parseArguments(rawArguments);
    const chats = await this.telegram.listChats(clamp(args.limit, DEFAULT_LIMIT));

    if (!chats.length) {
      return (
        "Nothing has arrived in the caller's Telegram chats since they connected. Say that plainly " +
        "rather than suggesting there may be older messages."
      );
    }

    return [
      "The caller's Telegram chats with something in them since they connected, most recent first.",
      ...chats.map(
        (chat) =>
          `[${chat.title}] ${chat.unreadFromThem} from them, last message ${iso(chat.lastMessageAt)}`,
      ),
    ].join("\n");
  }

  private async readMessages(rawArguments: string): Promise<string> {
    const args = parseArguments(rawArguments);
    const chat = text(args.chat);
    if (!chat) {
      return `Give telegram_read_messages the chat to read: a name from ${LIST_CHATS}, or the person's @username.`;
    }

    const messages = await this.telegram.readMessages(chat, clamp(args.limit, DEFAULT_LIMIT));
    if (!messages.length) {
      return (
        `Nothing is stored for "${chat}". Either nothing has arrived there since the caller connected, ` +
        `or that name is wrong — "${LIST_CHATS}" lists the chats that exist.`
      );
    }

    return [
      `Messages in "${chat}", oldest first. Only what arrived since the caller connected exists.`,
      ...messages.map(
        (message) => `${message.outgoing ? "Caller" : message.from}: ${message.text} (${iso(message.at)})`,
      ),
    ].join("\n");
  }

  private async prepareSend(rawArguments: string): Promise<string> {
    const args = parseArguments(rawArguments);
    const to = text(args.to);
    const body = text(args.text);
    if (!to) return `Give ${PREPARE_SEND} who to send to: the person's @username.`;
    if (!body) return `Give ${PREPARE_SEND} the exact message text.`;

    const prepared = await this.telegram.prepareSend(to, body);
    if (!prepared.ok || !prepared.text) {
      return prepared.reason ?? "That message could not be prepared.";
    }

    return [
      `Prepared, and NOT sent yet. To: ${prepared.title} (${prepared.to}).`,
      `Message: "${prepared.text}"`,
      `Read that back to the caller and ask them to confirm. Call ${CONFIRM_SEND} only after they say yes.`,
    ].join("\n");
  }

  private async confirmSend(): Promise<string> {
    const sent = await this.telegram.sendPending();
    if (!sent.ok) return sent.reason ?? "The message was not sent.";
    return `Sent to ${sent.title} (${sent.to}).`;
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A model-supplied count, held to something a spoken answer can carry. */
function clamp(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

function iso(at: number): string {
  return new Date(at).toISOString();
}
