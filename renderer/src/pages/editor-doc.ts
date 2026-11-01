import type { JSONContent } from "@tiptap/core";

/**
 * Pure conversions between the host's plain text and TipTap documents.
 *
 * Plain content is stored as `html: null`; the editor still works on a
 * document, so a plain body is rebuilt as one paragraph per source line. Text
 * is placed in JSON text nodes, never interpolated into an HTML string.
 */

/** Mirrors the host limit: text or HTML above 4 MiB (UTF-8) is not saved. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const PLAIN_NODE_TYPES: Record<string, true> = { doc: true, paragraph: true, text: true, hardBreak: true };
const encoder = new TextEncoder();

/**
 * A document is "plain" when it only uses paragraphs, text and hard breaks
 * with no marks — exactly what the host stores as `html: null`.
 */
export function isPlainDoc(doc: JSONContent | null | undefined): boolean {
  if (!doc || typeof doc !== "object" || doc.type !== "doc") return false;
  return isPlainNode(doc);
}

function isPlainNode(node: JSONContent): boolean {
  if (!node.type || !PLAIN_NODE_TYPES[node.type]) return false;
  if (node.marks && node.marks.length > 0) return false;
  if (node.type === "text" && typeof node.text !== "string") return false;
  const children = node.content;
  if (!children) return true;
  return children.every(isPlainNode);
}

/** One paragraph per line; blank lines become empty paragraphs. */
export function plainTextToDoc(text: string): JSONContent {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    type: "doc",
    content: lines.map((line) =>
      line.length > 0
        ? { type: "paragraph", content: [{ type: "text", text: line }] }
        : { type: "paragraph" },
    ),
  };
}

/** UTF-8 byte length, matching what the host measures before writing. */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** True when the body the editor wants to save would exceed the host limit. */
export function exceedsBodyLimit(text: string, html: string | null): boolean {
  return utf8ByteLength(text) > MAX_BODY_BYTES || (html !== null && utf8ByteLength(html) > MAX_BODY_BYTES);
}
