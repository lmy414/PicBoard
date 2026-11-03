import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const harness = 'http://127.0.0.1:5173/tests/browser/floating-board.html';
async function openBoard(page: Page, history = true) {
  await page.goto(`${harness}?sidebar=off&history=${history ? 'on' : 'off'}`);
  await expect(page.getByRole('toolbar', { name: '画板工具', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveClass(/closed/);
}
async function peek(page: Page) {
  await page.locator('.sidebar-toggle').hover();
  await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await expect(page.getByRole('button', { name: '固定侧边栏', exact: true })).toBeVisible();
}
async function leave(page: Page) {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width - 80, viewport.height / 2);
}
async function capture(page: Page, path: string) {
  await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, animations: 'disabled' });
}

for (const width of [1440, 1000, 720]) for (const history of [true, false]) {
  test(`hover bridge, pin and collapse at ${width}px with history ${history ? 'on' : 'off'}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 700 });
    await openBoard(page, history);
    await expect(page.locator('.sidebar-heading')).toHaveCount(0);
    const initial = (await page.locator('.workspace-main').boundingBox())!;
    const trigger = (await page.locator('.sidebar-toggle').boundingBox())!;
    await peek(page);
    // Cross the real gap below the trigger, staying inside the grace period.
    await page.mouse.move(trigger.x + trigger.width / 2, 47); await page.waitForTimeout(70);
    await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
    const heading = (await page.locator('.sidebar-search').boundingBox())!;
    await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
    await page.waitForTimeout(240);
    await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
    const floating = (await page.locator('.workspace-main').boundingBox())!;
    expect(floating.x).toBeCloseTo(initial.x, 1); expect(floating.width).toBeCloseTo(initial.width, 1);
    expect(await page.evaluate(() => localStorage.getItem('quick-image-board.sidebar-collapsed'))).toBe('1');
    const panel = (await page.locator('.sidebar-content').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    await capture(page, info.outputPath('screenshots', `sidebar-${width}-${history ? 'history' : 'clear'}-floating.png`));
    await leave(page);
    await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
    await expect(page.locator('.sidebar')).toHaveClass(/closed/);
    await expect(page.locator('.sidebar-content')).toHaveAttribute('inert', '');
    await peek(page);
    await page.getByRole('button', { name: '固定侧边栏', exact: true }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
    await expect.poll(async () => (await page.locator('.workspace-main').boundingBox())!.x).toBeGreaterThan(initial.x + 240);
    await leave(page); await page.waitForTimeout(260);
    await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
    await page.locator('.sidebar-toggle').click();
    await expect(page.locator('.sidebar')).toHaveClass(/closed/);
    await expect(page.locator('.sidebar-toggle')).toBeFocused();
    await expect.poll(async () => (await page.locator('.workspace-main').boundingBox())!.x).toBeCloseTo(initial.x, 1);
    await expect(page.locator('.workspace-navigation')).toHaveCount(0);
    for (const name of ['最大化窗口', '最小化窗口', '关闭（按设置处理）']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  });
}

test('keyboard search holds the floating panel and Escape first clears then returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 }); await openBoard(page);
  await page.keyboard.press('Control+k');
  const search = page.getByRole('textbox', { name: '搜索画布' });
  await expect(search).toBeFocused(); await search.fill('没有匹配的画布');
  await leave(page); await page.waitForTimeout(300);
  await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await page.keyboard.press('Escape'); await expect(search).toHaveValue(''); await expect(search).toBeFocused();
  await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await page.keyboard.press('Escape'); await expect(page.locator('.sidebar')).toHaveClass(/closed/);
  await expect(page.locator('.sidebar-toggle')).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await page.locator('.sidebar-content').evaluate(node => node.contains(document.activeElement))).toBe(false);
});

test('portalled tree menu and its rename dialog keep the drawer open, then Escape unwinds each layer', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 }); await openBoard(page); await peek(page);
  const row = page.locator('.tree-node.active');
  await row.click({ button: 'right', position: { x: 200, y: 14 } });
  const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  await page.mouse.move(menuBox.x + menuBox.width - 8, menuBox.y + 10);
  await page.waitForTimeout(320); await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused(); await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await page.keyboard.press('Escape'); await expect(page.locator('.sidebar')).toHaveClass(/closed/);
  await expect(page.locator('.sidebar-toggle')).toBeFocused();
  await peek(page); await row.click({ button: 'right', position: { x: 200, y: 14 } });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await leave(page); await page.waitForTimeout(320);
  await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await page.keyboard.press('Escape'); await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await page.keyboard.press('Escape'); await expect(page.locator('.sidebar')).toHaveClass(/closed/);
});

test('an HTML tree drag crossing the panel boundary does not discard the drawer before dragend', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 }); await openBoard(page); await peek(page);
  const row = page.locator('.tree-node.active'); await row.hover();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent('dragstart', { dataTransfer });
  await expect(page.getByText('拖到此处设为根画布', { exact: true })).toBeVisible();
  await leave(page); await page.waitForTimeout(320);
  await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await row.dispatchEvent('dragend', { dataTransfer, clientX: 700, clientY: 320 });
  await expect(page.locator('.sidebar')).toHaveClass(/closed/);
  await dataTransfer.dispose();
});

for (const width of [1440, 720]) {
  test(`settings opens stable navigation at ${width}px and returns to the previous canvas preference`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 700 }); await openBoard(page, false); await peek(page);
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '设置项目' })).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
    await expect(page.getByRole('textbox', { name: '搜索设置' })).toBeVisible();
    await leave(page); await page.waitForTimeout(320);
    await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
    await page.getByRole('navigation', { name: '设置项目' }).getByRole('button', { name: '剪贴板', exact: true }).click();
    await expect(page.getByRole('heading', { name: '剪贴板', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '设置项目' }).getByRole('button', { name: '剪贴板', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => localStorage.getItem('quick-image-board.sidebar-collapsed'))).toBe('1');
    const boxes = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar-content')!.getBoundingClientRect();
      const main = document.querySelector('.workspace-main')!.getBoundingClientRect();
      return { right: sidebar.right, content: main.left, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(boxes.right).toBeLessThanOrEqual(boxes.content + 1); expect(boxes.overflow).toBe(false);
    await capture(page, info.outputPath('screenshots', `sidebar-settings-${width}.png`));
    await page.getByRole('button', { name: '返回画布', exact: true }).click();
    await expect(page.getByRole('toolbar', { name: '画板工具', exact: true })).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveClass(/closed/);
  });
}

test('reduced motion and viewport changes retain the explicit pin choice', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 900, height: 600 }); await openBoard(page); await peek(page);
  expect(await page.locator('.sidebar-content').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
  await page.locator('.sidebar-toggle').click(); await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
  await page.setViewportSize({ width: 1440, height: 700 }); await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
  await page.setViewportSize({ width: 720, height: 480 }); await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
  await page.locator('.sidebar-toggle').click(); await expect(page.locator('.sidebar')).toHaveClass(/closed/);
  await page.setViewportSize({ width: 1440, height: 700 }); await expect(page.locator('.sidebar')).toHaveClass(/closed/);
});

for (const width of [720, 1440]) {
  test(`first closed mount is inert and CtrlK focuses only after commit with reduced motion at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 700 }); await openBoard(page, false);
    await expect(page.locator('.sidebar-content')).toHaveAttribute('inert', '');
    for (const view of ['canvas', 'settings']) {
      if (view === 'settings') {
        await peek(page); await page.getByRole('button', { name: '打开设置', exact: true }).click();
        await expect(page.getByRole('navigation', { name: '设置项目' })).toBeVisible();
        await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
      }
      for (let repetition = 0; repetition < 3; repetition++) {
        await expect(page.locator('.sidebar')).toHaveClass(/closed/);
        await expect(page.locator('.sidebar-content')).toHaveAttribute('inert', '');
        await page.keyboard.press('Control+k');
        const search = page.getByRole('textbox', { name: view === 'settings' ? '搜索设置' : '搜索画布', exact: true });
        await expect(search).toBeFocused();
        await expect(page.locator('.sidebar-content')).not.toHaveAttribute('inert', '');
        await page.keyboard.press('Escape');
        await expect(page.locator('.sidebar-toggle')).toBeFocused();
      }
    }
  });
}
