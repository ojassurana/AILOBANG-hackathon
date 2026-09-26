/**
 * What a file send is made of, before any of it reaches Telegram.
 *
 * A file arrives one of three ways: a link to download (what Composio, the web
 * and image tools hand back), text to be sent as a file (a note, a CSV the
 * model wrote), or raw bytes as base64 (what a program already holds). This
 * module settles which, and what the file is called, without a socket or a
 * fetch, so the rules can be tested on their own.
 */

/** How the file should appear in the chat. */
export type FileMode = "auto" | "document" | "voice";

export interface OutgoingFile {
  /** An http(s) link to download the file from. */
  url?: string;
  /** Text to send as the file's contents. */
  content?: string;
  /** The file's bytes, base64-encoded. */
  base64?: string;
  /** The name the recipient sees; its extension decides photo, video or document. */
  filename?: string;
  caption?: string;
  /** "auto" sends images as photos and videos as videos; "document" never compresses. */
  as?: FileMode;
}

/** Where the bytes come from, once the request has been checked. */
export type FileSource =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Uint8Array; mimeType: string };

export interface SettledFile {
  source: FileSource;
  filename: string | null;
  caption: string;
  mode: FileMode;
}

/**
 * teleproto holds anything above this on disk rather than in memory, and a
 * Durable Object has no disk, so this is the most one send can carry.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024 - 1;

/** Telegram's own limit on a media caption. */
export const MAX_CAPTION_CHARS = 1024;

const EXTENSION_FOR_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/json": ".json",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
};

/** Checks what the caller asked to send, or says what is missing. */
export function settleFile(file: OutgoingFile): SettledFile | { reason: string } {
  const url = typeof file.url === "string" ? file.url.trim() : "";
  const content = typeof file.content === "string" ? file.content : "";
  const base64 = typeof file.base64 === "string" ? file.base64.trim() : "";
  const given = [url, content, base64].filter(Boolean).length;

  if (given === 0) return { reason: "There was no file to send: give a url, the text content, or base64 bytes." };
  if (given > 1) return { reason: "Give only one of url, content or base64 — one file per send." };

  const caption = (typeof file.caption === "string" ? file.caption.trim() : "").slice(0, MAX_CAPTION_CHARS);
  const mode: FileMode = file.as === "document" || file.as === "voice" ? file.as : "auto";
  const filename = cleanFilename(file.filename);

  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { reason: `"${url.slice(0, 200)}" is not a link that can be downloaded.` };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { reason: "Only http and https links can be sent as files." };
    }
    return { source: { kind: "url", url: parsed.toString() }, filename, caption, mode };
  }

  if (content) {
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > MAX_FILE_BYTES) return { reason: tooBig(bytes.byteLength) };
    return {
      source: { kind: "bytes", bytes, mimeType: "text/plain" },
      filename: filename ?? "message.txt",
      caption,
      mode,
    };
  }

  const bytes = decodeBase64(base64);
  if (!bytes) return { reason: "The base64 bytes could not be decoded." };
  if (bytes.byteLength > MAX_FILE_BYTES) return { reason: tooBig(bytes.byteLength) };
  return { source: { kind: "bytes", bytes, mimeType: "application/octet-stream" }, filename, caption, mode };
}

/**
 * The name to send under. teleproto picks photo, video or document from the
 * extension alone, so a name without one borrows it from the content type, and
 * a name with none of either falls back to the last part of the link.
 */
export function fileNameFor(chosen: string | null, contentType: string | null, url: string | null): string {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const extension = EXTENSION_FOR_TYPE[type] ?? "";

  let name = chosen;
  if (!name && url) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      name = cleanFilename(last);
    } catch {
      name = null;
    }
  }
  if (!name) name = "file";

  return hasExtension(name) || !extension ? name : `${name}${extension}`;
}

/** What the repeat guard compares, so the same file to the same person is one send. */
export function fileFingerprint(file: SettledFile, filename: string): string {
  const source = file.source.kind === "url" ? file.source.url : `${file.source.bytes.byteLength} bytes`;
  return `[file] ${filename} ${source} ${file.caption}`.trim();
}

export function tooBig(bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `That file is ${mb} MB; at most 20 MB can be sent from here.`;
}

function cleanFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, "").trim() ?? "";
  return name ? name.slice(0, 200) : null;
}

function hasExtension(name: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(name);
}

function decodeBase64(value: string): Uint8Array | null {
  const cleaned = value.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.byteLength ? bytes : null;
  } catch {
    return null;
  }
}
