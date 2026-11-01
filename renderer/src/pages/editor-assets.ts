import type { ContentAsset } from "../../../shared/image-board";
import { assetRef, parseAssetRef } from "../content/content-meta";

/**
 * Pure helpers for images embedded in rich text: data-asset references,
 * data-URI decoding and schema-safe rewriting of pasted HTML.
 *
 * Pasted HTML is only ever parsed in a DOMParser document (inert: no scripts,
 * no browsing context) and serialized with XMLSerializer; the resulting string
 * is handed to TipTap's schema parser, never assigned to the live DOM.
 */

export { assetRef, parseAssetRef };

const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const IMAGE_FILE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;

/** Elements PicBoard never keeps: embedded browsing, media fetching and scripts. */
const DROPPED_TAGS = ["script", "style", "link", "iframe", "object", "embed", "video", "audio", "source", "picture", "form", "input", "button", "meta"];

/** HTML that needs the inert sanitizer before it reaches the schema parser. */
export const PASTE_SANITIZE_PATTERN = /<(img|picture|source|video|audio|iframe|object|embed|link|style|script|form|input|button|meta)[\s>]/i;

export function imageFileName(mime: string): string {
  return `image.${MIME_EXTENSION[mime.toLowerCase()] ?? "png"}`;
}

/** Files the host may accept; unsupported image types still go to the host so it can explain why. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSION.test(file.name);
}

export interface DecodedDataImage {
  mime: string;
  bytes: Uint8Array;
}

/** Decode a `data:image/...` URI for the formats PicBoard stores. */
export function decodeDataImage(uri: string): DecodedDataImage | null {
  const raw = (uri ?? "").trim();
  if (!raw.startsWith("data:")) return null;
  const comma = raw.indexOf(",");
  if (comma < 0) return null;
  const header = raw.slice(5, comma);
  const payload = raw.slice(comma + 1);
  if (!header || !payload) return null;

  const parts = header.split(";").map((part) => part.trim());
  const mime = (parts[0] || "").toLowerCase();
  const extension = MIME_EXTENSION[mime] ?? MIME_EXTENSION[mime === "image/jpg" ? "image/jpeg" : mime];
  if (!extension) return null;
  const normalizedMime = mime === "image/jpg" ? "image/jpeg" : mime;
  const base64 = parts.some((part) => part.toLowerCase() === "base64");

  try {
    if (base64) {
      const binary = atob(payload.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/"));
      if (binary.length === 0) return null;
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
      return { mime: normalizedMime, bytes };
    }
    const text = decodeURIComponent(payload);
    if (text.length === 0) return null;
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
    return { mime: normalizedMime, bytes };
  } catch {
    return null;
  }
}

export function parseInertHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

export function serializeInertBody(document: Document): string {
  const serializer = new XMLSerializer();
  return Array.from(document.body.childNodes)
    .map((node) => serializer.serializeToString(node))
    .join("");
}

export interface SanitizeResult {
  html: string;
  uploaded: number;
  /** Supported data URIs the host rejected. */
  failed: number;
  /** Data URIs with a format PicBoard cannot store. */
  unsupported: number;
}

/**
 * Keep only stored `img[data-asset]` images, upload supported data URIs through
 * `upload`, and drop remote URLs, file paths and unsupported data that the
 * schema would reject anyway. Returns serialized HTML for `insertContent`.
 */
export async function sanitizePastedHtml(
  html: string,
  contentId: string,
  upload: (image: DecodedDataImage, alt: string) => Promise<ContentAsset | null>,
): Promise<SanitizeResult> {
  if (!PASTE_SANITIZE_PATTERN.test(html)) return { html, uploaded: 0, failed: 0, unsupported: 0 };

  const document = parseInertHtml(html);
  for (const tag of DROPPED_TAGS) {
    for (const element of Array.from(document.querySelectorAll(tag))) element.remove();
  }
  const cache = new Map<string, ContentAsset | null>();
  let uploaded = 0;
  let failed = 0;
  let unsupported = 0;

  for (const image of Array.from(document.querySelectorAll("img"))) {
    const existing = image.getAttribute("data-asset");
    if (existing && parseAssetRef(existing)) {
      image.removeAttribute("src");
      continue;
    }

    const source = (image.getAttribute("src") ?? "").trim();
    if (!/^data:image\//i.test(source)) {
      // Remote URLs and local paths are never fetched or kept.
      image.remove();
      continue;
    }

    const decoded = decodeDataImage(source);
    if (!decoded) {
      image.remove();
      unsupported += 1;
      continue;
    }

    let asset = cache.get(source);
    if (asset === undefined) {
      const alt = image.getAttribute("alt") ?? "";
      asset = await upload(decoded, alt);
      cache.set(source, asset);
      if (asset) uploaded += 1;
      else failed += 1;
    }
    if (!asset) {
      image.remove();
      continue;
    }

    image.setAttribute("data-asset", assetRef(contentId, asset.assetId));
    image.removeAttribute("src");
    if (!image.hasAttribute("alt")) image.setAttribute("alt", "");
    if (asset.width > 0) image.setAttribute("width", String(asset.width));
    if (asset.height > 0) image.setAttribute("height", String(asset.height));
  }

  return { html: serializeInertBody(document), uploaded, failed, unsupported };
}
