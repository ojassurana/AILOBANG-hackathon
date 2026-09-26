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
    // Text asked for as a PDF has to become one: text bytes under a .pdf name
    // arrive as a file no reader will open.
    const asPdf = /\.pdf$/i.test(filename ?? "");
    const bytes = asPdf ? textToPdf(content) : new TextEncoder().encode(content);
    if (bytes.byteLength > MAX_FILE_BYTES) return { reason: tooBig(bytes.byteLength) };
    return {
      source: { kind: "bytes", bytes, mimeType: asPdf ? "application/pdf" : "text/plain" },
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

const PDF_PAGE = { width: 612, height: 792, margin: 54, fontSize: 11, lineHeight: 14 };
/** Helvetica averages about half an em a character, which is what this wraps by. */
const PDF_LINE_CHARS = Math.floor((PDF_PAGE.width - 2 * PDF_PAGE.margin) / (PDF_PAGE.fontSize * 0.5));
const PDF_PAGE_LINES = Math.floor((PDF_PAGE.height - 2 * PDF_PAGE.margin) / PDF_PAGE.lineHeight);

/**
 * Plain text as a letter-size PDF in Helvetica, wrapped and paginated.
 *
 * The standard fonts only carry Latin-1, so anything outside it is shown as
 * "?" rather than breaking the file. Blank lines are kept, so paragraphs stay.
 */
export function textToPdf(text: string): Uint8Array {
  const lines = wrapLines(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "), PDF_LINE_CHARS);
  const pages: string[][] = [];
  for (let start = 0; start < Math.max(lines.length, 1); start += PDF_PAGE_LINES) {
    pages.push(lines.slice(start, start + PDF_PAGE_LINES));
  }

  // Objects: 1 catalog, 2 page tree, 3 font, then a page and its content per page.
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((pageLines, index) => {
    const pageId = pageIds[index];
    const top = PDF_PAGE.height - PDF_PAGE.margin - PDF_PAGE.fontSize;
    const body = pageLines.map((line) => `(${pdfString(line)}) Tj T*`).join("\n");
    const stream =
      `BT /F1 ${PDF_PAGE.fontSize} Tf ${PDF_PAGE.lineHeight} TL ${PDF_PAGE.margin} ${top} Td\n${body}\nET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE.width} ${PDF_PAGE.height}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // Every character is Latin-1 by now, so string offsets are byte offsets.
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i);
  return bytes;
}

function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      for (let piece = word; piece; piece = piece.slice(width)) {
        const chunk = piece.slice(0, width);
        if (!line) line = chunk;
        else if (line.length + 1 + chunk.length <= width) line += ` ${chunk}`;
        else {
          out.push(line);
          line = chunk;
        }
      }
    }
    out.push(line);
  }
  return out;
}

/** Punctuation outside Latin-1 that WinAnsi still carries, at its WinAnsi byte. */
const WIN_ANSI_EXTRAS: Record<string, number> = {
  "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99,
};

/** A line as a PDF literal string in WinAnsi, with its delimiters escaped. */
function pdfString(line: string): string {
  return Array.from(line, (char) => {
    const extra = WIN_ANSI_EXTRAS[char];
    if (extra !== undefined) return String.fromCharCode(extra);
    const code = char.codePointAt(0) ?? 63;
    const latin = (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) ? char : "?";
    return latin === "\\" || latin === "(" || latin === ")" ? `\\${latin}` : latin;
  }).join("");
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
