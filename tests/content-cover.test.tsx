// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ContentRecord } from "../shared/image-board";
import { ContentCover, contentCoverSource } from "../renderer/src/library/ContentCover";

const NOW = "2026-05-15T04:00:00.000Z";

function content(overrides: Partial<ContentRecord> = {}): ContentRecord {
  return {
    id: "c1",
    kind: "richText",
    preview: "hello",
    textLength: 5,
    url: null,
    image: null,
    coverAsset: null,
    categoryId: null,
    source: "clipboard",
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: NOW,
    ...overrides,
  };
}

window.imageBoard = {
  assetUrl: (contentId: string, assetId: string, variant: string) => `asset://${variant}/${contentId}/${assetId}`,
  imageUrl: (contentId: string, variant: string) => `image://${variant}/${contentId}`,
} as unknown as typeof window.imageBoard;

afterEach(cleanup);

test("rich text covers use the asset protocol thumbnail", () => {
  const rich = content({ coverAsset: "c1/a9" });
  expect(contentCoverSource(rich)).toBe("asset://thumb/c1/a9");
  const view = render(<ContentCover content={rich} />);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("asset://thumb/c1/a9");
  expect(view.container.querySelector(".content-cover")?.className).toContain("is-loading");
});

test("image contents keep using the image thumbnail URL", () => {
  const image = content({
    kind: "image",
    image: { fileName: "a.png", relativePath: "images/a.png", width: 4, height: 5, byteSize: 6 },
  });
  expect(contentCoverSource(image)).toBe("image://thumb/c1");
});

test("no cover source for plain contents", () => {
  const view = render(<ContentCover content={content()} />);
  expect(contentCoverSource(content())).toBeNull();
  expect(view.container.querySelector(".content-cover")).toBeNull();
});
