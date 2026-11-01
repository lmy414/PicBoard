import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  exceedsBodyLimit,
  isPlainDoc,
  plainTextToDoc,
  utf8ByteLength,
} from "../renderer/src/pages/editor-doc";

const paragraph = (text?: string) => ({
  type: "paragraph",
  ...(text === undefined ? {} : { content: [{ type: "text", text }] }),
});

describe("isPlainDoc", () => {
  it("accepts paragraph text and hard breaks", () => {
    expect(
      isPlainDoc({
        type: "doc",
        content: [
          paragraph("第一行"),
          { type: "paragraph", content: [{ type: "text", text: "第二行" }, { type: "hardBreak" }, { type: "text", text: "续行" }] },
          paragraph(),
        ],
      }),
    ).toBe(true);
  });

  it("accepts an empty document", () => {
    expect(isPlainDoc({ type: "doc" })).toBe(true);
    expect(isPlainDoc({ type: "doc", content: [paragraph()] })).toBe(true);
  });

  it("treats any mark as rich content", () => {
    expect(
      isPlainDoc({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "加粗", marks: [{ type: "bold" }] }] }],
      }),
    ).toBe(false);
    expect(
      isPlainDoc({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "链接", marks: [{ type: "link", attrs: { href: "https://a.b" } }] }] }],
      }),
    ).toBe(false);
  });

  it("treats block structure as rich content", () => {
    const blocks = [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
      { type: "blockquote", content: [paragraph("引用")] },
      { type: "codeBlock", content: [{ type: "text", text: "code" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("项")] }] },
      { type: "orderedList", content: [{ type: "listItem", content: [paragraph("项")] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("待办")] }] },
      { type: "table", content: [] },
      { type: "horizontalRule" },
    ];
    for (const block of blocks) {
      expect(isPlainDoc({ type: "doc", content: [block] })).toBe(false);
    }
  });

  it("rejects non-document roots", () => {
    expect(isPlainDoc(null)).toBe(false);
    expect(isPlainDoc({})).toBe(false);
    expect(isPlainDoc(paragraph("no doc"))).toBe(false);
  });
});

describe("plainTextToDoc", () => {
  it("creates one paragraph per line, including empty lines", () => {
    const doc = plainTextToDoc("第一行\n\n第三行");
    expect(doc).toEqual({
      type: "doc",
      content: [paragraph("第一行"), paragraph(), paragraph("第三行")],
    });
  });

  it("handles CRLF and CR line endings", () => {
    expect(plainTextToDoc("a\r\nb\rc")).toEqual({
      type: "doc",
      content: [paragraph("a"), paragraph("b"), paragraph("c")],
    });
  });

  it("keeps markup-looking text literal", () => {
    const text = '<img src=x onerror="alert(1)"> & <b>bold</b>';
    const doc = plainTextToDoc(text);
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0].content?.[0]).toEqual({ type: "text", text });
    expect(doc.content?.[0].content?.[0]).not.toHaveProperty("type", "html");
  });

  it("produces a single empty paragraph for empty text", () => {
    expect(plainTextToDoc("")).toEqual({ type: "doc", content: [paragraph()] });
  });
});

describe("body size limits", () => {
  it("measures UTF-8 bytes", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("refuses text or HTML over 4 MiB", () => {
    expect(exceedsBodyLimit("a".repeat(MAX_BODY_BYTES), null)).toBe(false);
    expect(exceedsBodyLimit("a".repeat(MAX_BODY_BYTES + 1), null)).toBe(true);
    expect(exceedsBodyLimit("ok", `<p>${"a".repeat(MAX_BODY_BYTES)}</p>`)).toBe(true);
    expect(exceedsBodyLimit("ok", null)).toBe(false);
  });
});
