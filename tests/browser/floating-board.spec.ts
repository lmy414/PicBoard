import { expect, test, type Locator, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

type Board = {
  calls: { place: Array<{ contentId: string; canvasId: string; point: { x: number; y: number } }>;
    save: Array<{ id: string; name: string; bytes: number; width: number; height: number }>;
    open: string[]; drags: number };
  state: { contents: Record<string, unknown>; canvases: Array<{ id: string; nodes: Array<{ id: string; contentId: string }> }> };
};
test.use({ reducedMotion: 'reduce' });

const harness = 'http://127.0.0.1:5173/tests/browser/floating-board.html';
async function openBoard(page: Page, history = true) {
  await page.goto(`${harness}?history=${history ? 'on' : 'off'}`);
  await expect(page.getByRole('toolbar', { name: '画板工具', exact: true })).toBeVisible();
  await expect(page.locator('.canvas-node')).toHaveCount(3);
}
async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForFunction(() => Array.from(document.images).every(image => image.complete));
  await expect.poll(() => page.locator('.canvas-node, .canvas-dock-motion').evaluateAll(elements => elements.every(element => Number(getComputedStyle(element).opacity) === 1))).toBe(true);
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({ path: resolve(`test-results/floating-board-${name}.png`), fullPage: true });
}
async function assertHitTargets(locator: Locator) {
  const blocked = await locator.evaluateAll(elements => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden') return [];
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && element.contains(hit) ? [] : [{ label: element.getAttribute('aria-label') || element.textContent,
      hit: hit?.getAttribute('aria-label') || hit?.className || null, x, y }];
  }));
  expect(blocked, 'visible control centers must receive pointer input').toEqual([]);
}

async function assertFloatingSurfacesDoNotOverlap(page: Page) {
  const overlaps = await page.locator('.selection-toolbar, .canvas-dock, .canvas-view-dock, .mini-map').evaluateAll(elements => {
    const visible = elements.filter(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    });
    return visible.flatMap((element, index) => visible.slice(index + 1).flatMap(other => {
      const a = element.getBoundingClientRect(), b = other.getBoundingClientRect();
      return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        ? [`${element.className} overlaps ${other.className}`] : [];
    }));
  });
  expect(overlaps, 'selection, tools and minimap must reserve separate visible areas').toEqual([]);
}

for (const size of [{ width: 1920, height: 1080 }, { width: 1000, height: 700 }, { width: 720, height: 480 }]) {
  for (const history of [true, false]) {
    test(`floating capsules ${size.width}x${size.height}, history ${history ? 'on' : 'off'}`, async ({ page }) => {
      await page.setViewportSize(size);
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await openBoard(page, history);
      await screenshot(page, `${size.width}x${size.height}-history-${history ? 'on' : 'off'}`);
      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const value = document.querySelector(selector)!.getBoundingClientRect();
          return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
        };
        const canvas = rect('.canvas-viewport');
        const dock = rect('.canvas-dock');
        const historyPanel = document.querySelector('.history-slot.open:not([inert]) .hist-drawer');
        const drawer = historyPanel?.getBoundingClientRect();
        const visibleRight = drawer && drawer.width > 0 && drawer.left < canvas.right && drawer.bottom > dock.top && drawer.top < dock.bottom ? Math.max(canvas.left, drawer.left) : canvas.right;
        return { canvas, visibleRight, dock, shell: rect('.app-shell'), header: rect('.topbar'),
          left: rect('.topbar-start'), right: rect('.topbar-actions'),
          headerPosition: getComputedStyle(document.querySelector('.topbar')!).position,
          scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
      });
      expect(boxes.headerPosition, 'the native title bar keeps its normal layout row').not.toBe('absolute');
      expect(boxes.header.height).toBeCloseTo(44, 0);
      expect(Math.abs(boxes.header.top - boxes.shell.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes.canvas.top - boxes.header.bottom), 'canvas starts directly below the 44px title bar').toBeLessThanOrEqual(2);
      await expect(page.locator('.workspace-navigation')).toHaveCount(0);
      const windowButtons = await page.locator('.topbar-actions > button').all();
      expect(windowButtons).toHaveLength(3);
      for (const button of windowButtons) {
        const box = (await button.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(boxes.header.top);
        expect(box.y + box.height).toBeLessThanOrEqual(boxes.header.bottom);
      }
      expect(boxes.left.right, 'top navigation and window capsules must not overlap').toBeLessThanOrEqual(boxes.right.left - 3);
      expect(boxes.scrollWidth).toBeLessThanOrEqual(boxes.viewportWidth);
      expect(boxes.dock.left).toBeGreaterThanOrEqual(boxes.canvas.left + 8);
      expect(boxes.dock.right).toBeLessThanOrEqual(boxes.visibleRight - 8);
      expect(boxes.dock.bottom).toBeLessThanOrEqual(Math.min(size.height, boxes.canvas.bottom) - 8);
      expect(boxes.dock.top).toBeGreaterThan(boxes.canvas.top + boxes.canvas.height / 2);
      expect(Math.abs((boxes.dock.left + boxes.dock.right) / 2 - (boxes.canvas.left + boxes.visibleRight) / 2), 'bottom dock must center in the unobscured canvas').toBeLessThanOrEqual(2);
      await assertHitTargets(page.locator('.canvas-dock button, .canvas-view-dock button, .topbar button'));
      const dock = page.getByRole('toolbar', { name: '画板工具', exact: true });
      await page.getByRole('button', { name: '展开视图工具', exact: true }).click();
      await expect(page.getByRole('button', { name: '网格对齐', exact: true })).toBeVisible();
      const expandedView = (await page.locator('.canvas-view-dock').boundingBox())!;
      expect(Math.abs(expandedView.x - boxes.canvas.left - 18)).toBeLessThanOrEqual(2);
      const pan = dock.getByRole('button', { name: '平移工具', exact: true });
      const select = dock.getByRole('button', { name: '选择工具', exact: true });
      await pan.click(); await expect(pan).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.canvas-viewport')).toHaveClass(/hand-tool/);
      await select.click(); await expect(select).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.canvas-viewport')).not.toHaveClass(/hand-tool/);
      await page.locator('[data-node-id="original-node"]').click({ position: { x: 20, y: 25 } });
      await expect(page.locator('.selection-toolbar')).toBeVisible();
      await screenshot(page, `${size.width}x${size.height}-history-${history ? 'on' : 'off'}-selection`);
      await assertFloatingSurfacesDoNotOverlap(page);
      await assertHitTargets(page.locator('.selection-toolbar button, .canvas-dock button, .canvas-view-dock button'));
      const drag = (await page.locator('.window-drag-region').boundingBox())!;
      const dragPoint = { x: drag.x + drag.width - 20, y: drag.y + drag.height / 2 };
      expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.window-drag-region')), dragPoint)).toBe(true);
      await page.mouse.move(dragPoint.x, dragPoint.y); await page.mouse.down();
      await page.mouse.move(dragPoint.x - 30, dragPoint.y + 2, { steps: 4 }); await page.mouse.up();
      await expect.poll(() => page.evaluate(() => (window as unknown as { floatingBoard: Board }).floatingBoard.calls.drags)).toBe(1);
      expect(errors).toEqual([]);
    });
  }
}

async function editAndSave(page: Page) {
  await page.getByRole('button', { name: '编辑图像', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存副本', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '旋转', exact: true }).click();
  await page.getByRole('button', { name: '保存副本', exact: true }).click();
  await expect(page.locator('.page-layer')).toHaveCount(0);
  const copy = page.locator('[data-node-id="copy-1-node"]');
  await expect(copy).toHaveClass(/selected/);
  await expect(copy).toBeInViewport();
  const placement = await page.evaluate(() => {
    const board = (window as unknown as { floatingBoard: Board }).floatingBoard;
    return { calls: board.calls, state: board.state };
  });
  expect(placement.calls.save).toHaveLength(1);
  expect(placement.calls.save[0]).toMatchObject({ id: 'copy-1', width: 400, height: 640 });
  expect(placement.calls.save[0].bytes).toBeGreaterThan(100);
  expect(placement.calls.place.at(-1)).toMatchObject({ contentId: 'copy-1', canvasId: 'main' });
  expect(placement.state.contents).toHaveProperty('original');
  expect(placement.state.contents).toHaveProperty('copy-1');
  expect(placement.state.canvases.find(c => c.id === 'main')!.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'original-node', contentId: 'original' }),
    expect.objectContaining({ id: 'copy-1-node', contentId: 'copy-1' }),
  ]));
}

test('a real image edit saved from the canvas returns to the board and reveals the copy while retaining the original', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openBoard(page, false);
  await page.locator('[data-node-id="original-node"]').dblclick();
  await editAndSave(page);
  await screenshot(page, 'save-from-canvas');
});

test('a real image edit saved from the library is placed in the active canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openBoard(page, false);
  await page.locator('.sidebar-toggle').hover();
  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '分类库', exact: true }).click();
  await page.locator('.lib-card[aria-label="图片：山间灵感.png"]').dblclick();
  await editAndSave(page);
  await expect(page.locator('.lib-view')).toHaveCount(0);
  await screenshot(page, 'save-from-library');
});

test('the floating import button opens a file, places it on the board and keeps all dock actions clickable', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await openBoard(page, false);
  await page.getByRole('button', { name: '导入图片到画布', exact: true }).click();
  await expect(page.locator('[data-node-id="imported-node"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-node-id="imported-node"]')).toBeInViewport();
  const calls = await page.evaluate(() => (window as unknown as { floatingBoard: Board }).floatingBoard.calls);
  expect(calls.open).toEqual(['imported']);
  expect(calls.place).toEqual([expect.objectContaining({ contentId: 'imported', canvasId: 'main' })]);
  await expect(page.locator('.qib-toast')).toContainText('图片已放到画布');
  await screenshot(page, 'import-720x480');
  await assertHitTargets(page.locator('.canvas-dock button'));
});






test('720x480 pinned sidebar with history reserves a safe bottom area for both tool capsules', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await page.goto(`${harness}?history=on&sidebar=on`);
  await expect(page.getByRole('toolbar', { name: '画板工具', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
  await screenshot(page, '720x480-sidebar-history-on');
  const canvas = (await page.locator('.canvas-viewport').boundingBox())!;
  const dock = (await page.locator('.canvas-dock').boundingBox())!;
  const history = (await page.locator('.hist-drawer').boundingBox())!;
  const view = (await page.locator('.canvas-view-dock').boundingBox())!;
  expect(history.y + history.height).toBeLessThanOrEqual(Math.min(dock.y, view.y) - 4);
  expect(dock.x).toBeGreaterThanOrEqual(canvas.x + 8);
  expect(dock.x + dock.width).toBeLessThanOrEqual(canvas.x + canvas.width - 8);
  expect(Math.abs(dock.x + dock.width / 2 - canvas.x - canvas.width / 2)).toBeLessThanOrEqual(2);
  await assertHitTargets(page.locator('.canvas-dock button, .canvas-view-dock button, .topbar button'));
  await assertFloatingSurfacesDoNotOverlap(page);
  await page.getByRole('button', { name: '平移工具', exact: true }).click();
  await expect(page.locator('.canvas-viewport')).toHaveClass(/hand-tool/);
  await page.getByRole('button', { name: '选择工具', exact: true }).click();
  await expect(page.locator('.canvas-viewport')).not.toHaveClass(/hand-tool/);
});
