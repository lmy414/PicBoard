// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { ContentImage } from "../renderer/src/pages/editor-image";
import { isPlainDoc } from "../renderer/src/pages/editor-doc";

function makeEditor(content = "<p>x</p>") {
  const element = document.createElement("div");
  document.body.append(element);
  return new Editor({
    element,
    extensions: [StarterKit, ContentImage],
    content,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

test("parses only stored data-asset images and renders the asset URL", () => {
  window.imageBoard = {
    assetUrl: (contentId: string, assetId: string, variant: string) => `asset://${variant}/${contentId}/${assetId}`,
  } as unknown as typeof window.imageBoard;

  const editor = makeEditor("<p>before</p><p><img src=\"https://example.com/remote.png\"></p>");
  editor.commands.setContent(
    '<p>before</p><img data-asset="c1/a1" alt="shot" width="120" height="80" src="asset://full/c1/a1"><p>after</p>',
  );

  const json = editor.getJSON();
  const images = (json.content ?? []).filter((node) => node.type === "image");
  expect(images).toHaveLength(1);
  expect(images[0].attrs).toMatchObject({ asset: "c1/a1", alt: "shot", width: 120, height: 80 });
  expect(isPlainDoc(json)).toBe(false);

  const html = editor.getHTML();
  expect(html).toContain('data-asset="c1/a1"');
  expect(html).toContain('src="asset://full/c1/a1"');
  expect(html).toContain('width="120"');
  expect(html).toContain('height="80"');
  expect(html).not.toContain("example.com");
  expect(html).not.toContain("remote.png");

  const text = editor.getText({ blockSeparator: "\n", textSerializers: { image: () => "[图片]" } });
  expect(text).toContain("[图片]");
  editor.destroy();
});

test("drops remote, file and inline data images", () => {
  window.imageBoard = {
    assetUrl: () => "asset://full/x/y",
  } as unknown as typeof window.imageBoard;
  const editor = makeEditor();
  editor.commands.setContent(
    '<p>a</p><img src="https://example.com/a.png"><img src="file:///C:/a.png"><img src="data:image/png;base64,AAAA"><p>b</p>',
  );
  expect(editor.getJSON().content?.some((node) => node.type === "image")).toBe(false);
  expect(editor.getText({ blockSeparator: "\n" })).toBe("a\nb");
  editor.destroy();
});
