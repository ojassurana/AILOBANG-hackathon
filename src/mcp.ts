/**
 * Minimal MCP client for Composio's per-user Tool Router endpoint.
 *
 * The transport is "streamable HTTP": every request is a POST and the reply is
 * an SSE-framed JSON-RPC message. That endpoint is stateless — it returns no
 * `mcp-session-id` — so calls need no session bookkeeping beyond initialize.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcMessage {
  id?: number | string | null;
  result?: Record<string, any>;
  error?: { code?: number; message?: string };
}

export class McpClient {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async initialize(): Promise<void> {
    await this.require("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ailobang", version: "1.0" },
    });
    // A notification carries no id and gets an empty 202 back.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.require("tools/list", {});
    return (result?.tools ?? []) as McpTool[];
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const result = await this.require("tools/call", { name, arguments: args ?? {} });
    const text = ((result?.content ?? []) as { type?: string; text?: string }[])
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");

    return { text, isError: result?.isError === true };
  }

  private async require(method: string, params: unknown): Promise<Record<string, any> | undefined> {
    const id = this.nextId++;
    const messages = await this.post({ jsonrpc: "2.0", id, method, params });
    const reply = messages.find((message) => message.id === id);

    if (!reply) throw new Error(`mcp ${method}: no reply`);
    if (reply.error) throw new Error(`mcp ${method}: ${reply.error.message ?? JSON.stringify(reply.error)}`);
    return reply.result;
  }

  private async post(body: unknown): Promise<JsonRpcMessage[]> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`mcp ${response.status}: ${text.slice(0, 300)}`);

    const messages: JsonRpcMessage[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        messages.push(JSON.parse(trimmed.slice("data:".length).trim()) as JsonRpcMessage);
      } catch {
        // Keep-alive lines and partial frames are not JSON-RPC messages.
      }
    }
    return messages;
  }
}
