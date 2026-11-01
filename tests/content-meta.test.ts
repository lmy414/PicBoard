import { describe, expect, it } from "vitest";
import type { AppState, CanvasNode, CanvasRecord, ContentRecord } from "../shared/image-board";
import {
  buildPlacementIndex,
  contentTitle,
  formatByteSize,
  formatTimestamp,
  isHttpUrl,
  linkDomain,
  matchesQuery,
  relativeTime,
} from "../renderer/src/content/content-meta";

const NOW = new Date(2026, 4, 15, 12, 0, 0).getTime();

function makeContent(overrides: Partial<ContentRecord> = {}): ContentRecord {
  return {
    id: "c1",
    kind: "text",
    preview: "你好",
    textLength: 2,
    url: null,
    image: null,
    coverAsset: null,
    categoryId: null,
    source: "clipboard",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastUsedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makeNode(id: string, contentId: string): CanvasNode {
  return { id, contentId, x: 0, y: 0, width: 100, height: 100 };
}

function makeCanvas(id: string, nodes: CanvasNode[]): CanvasRecord {
  return {
    id,
    name: id,
    parentId: null,
    frame: null,
    nodes,
    createdAt: new Date(NOW).toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

describe("relativeTime", () => {
  it("labels the first minute as 刚刚", () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("刚刚");
    expect(relativeTime(new Date(NOW + 30_000).toISOString(), NOW)).toBe("刚刚");
  });

  it("counts minutes under an hour", () => {
    expect(relativeTime(new Date(NOW - 60_000).toISOString(), NOW)).toBe("1 分钟前");
    expect(relativeTime(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe("59 分钟前");
  });

  it("counts hours while still the same day", () => {
    expect(relativeTime(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe("1 小时前");
    expect(relativeTime(new Date(2026, 4, 15, 9, 0, 0).toISOString(), NOW)).toBe("3 小时前");
  });

  it("switches to 昨天 HH:mm for the previous calendar day", () => {
    expect(relativeTime(new Date(2026, 4, 14, 23, 5, 0).toISOString(), NOW)).toBe("昨天 23:05");
    expect(relativeTime(new Date(2026, 4, 14, 8, 0, 0).toISOString(), NOW)).toBe("昨天 08:00");
  });

  it("drops the time within the current year", () => {
    expect(relativeTime(new Date(2026, 0, 2, 8, 0, 0).toISOString(), NOW)).toBe("1月2日");
  });

  it("includes the year for older content", () => {
    expect(relativeTime(new Date(2025, 11, 31, 8, 0, 0).toISOString(), NOW)).toBe("2025年12月31日");
  });

  it("returns an empty label for invalid input", () => {
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});

describe("formatTimestamp", () => {
  it("prints the local full timestamp", () => {
    expect(formatTimestamp(new Date(2026, 4, 5, 9, 7, 0).toISOString())).toBe("2026年5月5日 09:07");
  });

  it("passes unparsable input through", () => {
    expect(formatTimestamp("oops")).toBe("oops");
  });
});

describe("linkDomain", () => {
  it("strips the scheme, path and leading www", () => {
    expect(linkDomain("https://www.Example.com/a/b?q=1")).toBe("example.com");
    expect(linkDomain("http://sub.example.com:8443/x")).toBe("sub.example.com");
  });

  it("falls back to the raw input when unparsable", () => {
    expect(linkDomain("example.com/path")).toBe("example.com/path");
    expect(linkDomain("")).toBe("");
  });
});

describe("isHttpUrl", () => {
  it("accepts only absolute http(s) URLs", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://example.com/a")).toBe(true);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///C:/x.png")).toBe(false);
    expect(isHttpUrl("example.com")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("contentTitle", () => {
  it("uses the first non-empty line of text previews", () => {
    expect(contentTitle(makeContent({ preview: "\n\n  第一行标题  \n第二行" }))).toBe("第一行标题");
    expect(contentTitle(makeContent({ preview: "   \n\t" }))).toBe("未命名");
  });

  it("caps long titles at 60 characters including the ellipsis", () => {
    const title = contentTitle(makeContent({ preview: "a".repeat(80) }));
    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("uses the domain for links and the file name for images", () => {
    expect(contentTitle(makeContent({ kind: "link", url: "https://www.example.com/x", preview: "https://www.example.com/x" }))).toBe("example.com");
    expect(
      contentTitle(
        makeContent({
          kind: "image",
          image: { fileName: "shot.png", relativePath: "images/shot.png", width: 100, height: 50, byteSize: 10 },
        }),
      ),
    ).toBe("shot.png");
    expect(contentTitle(makeContent({ kind: "image", image: null }))).toBe("未命名");
  });
});

describe("matchesQuery", () => {
  const content = makeContent({
    preview: "Hello 世界\nsecond line",
    url: "https://Example.com/Path",
    image: { fileName: "Screenshot.PNG", relativePath: "images/a.png", width: 1, height: 1, byteSize: 1 },
  });

  it("matches preview, URL and image name case-insensitively", () => {
    expect(matchesQuery(content, "hello")).toBe(true);
    expect(matchesQuery(content, "世界")).toBe(true);
    expect(matchesQuery(content, "example.com")).toBe(true);
    expect(matchesQuery(content, "screenshot.png")).toBe(true);
  });

  it("treats an empty or whitespace query as everything", () => {
    expect(matchesQuery(content, "")).toBe(true);
    expect(matchesQuery(content, "   ")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesQuery(content, "abc")).toBe(false);
  });
});

describe("buildPlacementIndex", () => {
  it("lists distinct canvases in canvas order", () => {
    const state = {
      activeCanvasId: "root",
      canvases: [
        makeCanvas("root", [makeNode("n1", "c1"), makeNode("n2", "c2"), makeNode("n3", "c1")]),
        makeCanvas("child", [makeNode("n4", "c1")]),
      ],
      categories: [],
      contents: {},
      edges: [],
    } as unknown as AppState;
    const index = buildPlacementIndex(state);
    expect(index.get("c1")).toEqual(["root", "child"]);
    expect(index.get("c2")).toEqual(["root"]);
    expect(index.get("missing")).toBeUndefined();
  });
});

describe("formatByteSize", () => {
  it("uses readable units", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1024)).toBe("1 KB");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(5 * 1024 * 1024)).toBe("5 MB");
  });
});
