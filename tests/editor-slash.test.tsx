// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SLASH_ITEMS, SlashMenu, filterSlashItems } from "../renderer/src/pages/editor-slash";

Element.prototype.scrollIntoView = function () {};

afterEach(cleanup);

test("an incidental mouseover does not move the keyboard selection", () => {
  const onHover = vi.fn();
  render(
    <SlashMenu
      menu={{
        items: SLASH_ITEMS,
        index: 0,
        rect: { left: 20, top: 20, right: 20, bottom: 20 },
      }}
      phase="enter"
      onHover={onHover}
      onPick={vi.fn()}
    />,
  );
  const items = document.querySelectorAll<HTMLElement>(".cp-slash-item");
  expect(items.length).toBeGreaterThan(1);

  fireEvent.mouseOver(items[1]);
  expect(onHover).not.toHaveBeenCalled();

  const move = new Event("pointermove", { bubbles: true, cancelable: true });
  Object.defineProperty(move, "pointerType", { value: "mouse" });
  items[1].dispatchEvent(move);
  expect(onHover).toHaveBeenCalledWith(1);
});

test("the image item is picker-driven and searchable by its aliases", () => {
  const image = SLASH_ITEMS.find((item) => item.id === "image");
  expect(image?.insertImage).toBe(true);
  expect(image?.title).toBe("图片");
  for (const alias of ["img", "image", "tupian", "tp"]) {
    expect(image?.aliases).toContain(alias);
  }
  const filtered = filterSlashItems("tp");
  expect(filtered.map((item) => item.id)).toContain("image");
});
