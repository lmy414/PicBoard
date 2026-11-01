// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import type { ContentAsset } from "../shared/image-board";
import {
  decodeDataImage,
  imageFileName,
  isImageFile,
  parseAssetRef,
  sanitizePastedHtml,
  serializeInertBody,
  assetRef,
} from "../renderer/src/pages/editor-assets";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_URI = `data:image/png;base64,${PNG}`;
const asset: ContentAsset = { assetId: "a1", mime: "image/png", width: 12, height: 8, byteSize: 68 };

test("parses asset references", () => {
  expect(parseAssetRef("content-1/asset-2")).toEqual({ contentId: "content-1", assetId: "asset-2" });
  expect(assetRef("c", "a")).toBe("c/a");
  expect(parseAssetRef("")).toBeNull();
  expect(parseAssetRef(null)).toBeNull();
  expect(parseAssetRef("no-slash")).toBeNull();
  expect(parseAssetRef("/asset")).toBeNull();
  expect(parseAssetRef("content/")).toBeNull();
});

test("decodes supported data image URIs", () => {
  const decoded = decodeDataImage(PNG_URI);
  expect(decoded?.mime).toBe("image/png");
  expect(decoded?.bytes.length).toBeGreaterThan(20);

  const plain = decodeDataImage("data:image/png,abc");
  expect(plain?.bytes).toEqual(new Uint8Array([97, 98, 99]));

  expect(decodeDataImage("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
  expect(decodeDataImage("data:text/plain;base64,YQ==")).toBeNull();
  expect(decodeDataImage("https://example.com/a.png")).toBeNull();
  expect(decodeDataImage("data:image/png;base64,")).toBeNull();
});

test("recognizes image files and names assets by mime", () => {
  expect(isImageFile(new File([new Uint8Array([1])], "shot.png", { type: "image/png" }))).toBe(true);
  expect(isImageFile(new File([new Uint8Array([1])], "vector.svg", { type: "image/svg+xml" }))).toBe(true);
  expect(isImageFile(new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" }))).toBe(false);
  expect(imageFileName("image/jpeg")).toBe("image.jpg");
  expect(imageFileName("image/webp")).toBe("image.webp");
});

test("rewrites data images and drops non-asset images", async () => {
  const upload = vi.fn(async () => asset);
  const html = `<p>Hello <strong>world</strong></p><img src="${PNG_URI}" alt="shot"><img src="https://example.com/remote.png"><img src="file:///C:/local.png"><img data-asset="c0/keep" src="https://example.com/kept.png" width="3" height="4">`;
  const result = await sanitizePastedHtml(html, "c9", upload);

  expect(upload).toHaveBeenCalledTimes(1);
  expect(result.uploaded).toBe(1);
  expect(result.failed).toBe(0);
  expect(result.unsupported).toBe(0);
  expect(result.html).toContain("Hello");
  expect(result.html).toContain("<strong>world</strong>");
  expect(result.html).toContain('data-asset="c9/a1"');
  expect(result.html).toContain('width="12"');
  expect(result.html).toContain('height="8"');
  expect(result.html).toContain('alt="shot"');
  expect(result.html).toContain('data-asset="c0/keep"');
  expect(result.html).not.toContain("data:image");
  expect(result.html).not.toContain("https://example.com");
  expect(result.html).not.toContain("file:///");
});

test("uploads a repeated data URI once and removes failed images", async () => {
  const upload = vi.fn(async () => (upload.mock.calls.length === 1 ? asset : null));
  const html = `<p>a</p><img src="${PNG_URI}"><img src="${PNG_URI}">`;
  const result = await sanitizePastedHtml(html, "c", async (image, alt) => upload(image, alt) as Promise<ContentAsset | null>);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(result.uploaded).toBe(1);
  expect((result.html.match(/data-asset="c\/a1"/g) ?? []).length).toBe(2);

  const failing = await sanitizePastedHtml(`<p>b</p><img src="${PNG_URI}">`, "c", async () => null);
  expect(failing.failed).toBe(1);
  expect(failing.unsupported).toBe(0);
  expect((failing.html.match(/<img/g) ?? []).length).toBe(0);
  expect(failing.html).toContain("b");
});

test("leaves HTML without images untouched", async () => {
  const upload = vi.fn(async () => asset);
  const html = "<p>plain <strong>rich</strong> text</p>";
  const result = await sanitizePastedHtml(html, "c", upload);
  expect(result).toEqual({ html, uploaded: 0, failed: 0, unsupported: 0 });
  expect(upload).not.toHaveBeenCalled();
});

test("serializes an inert body without innerHTML", () => {
  const document = new DOMParser().parseFromString("<p>x &amp; <b>y</b></p>", "text/html");
  expect(serializeInertBody(document)).toContain("x &amp;");
  expect(serializeInertBody(document)).toContain("<b>y</b>");
});

test("drops scripts and embedded media from pasted HTML", async () => {
  const upload = vi.fn(async () => asset);
  const html = `<p>keep</p><script>alert(1)</script><iframe src="https://example.com"></iframe><video src="https://example.com/a.mp4"></video><img src="https://example.com/a.png">`;
  const result = await sanitizePastedHtml(html, "c", upload);
  expect(result.html).toContain("keep");
  expect(result.html).not.toContain("<script");
  expect(result.html).not.toContain("<iframe");
  expect(result.html).not.toContain("<video");
  expect(result.html).not.toContain("example.com");
  expect(upload).not.toHaveBeenCalled();
});
