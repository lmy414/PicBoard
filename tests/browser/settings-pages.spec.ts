import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

test.use({ reducedMotion: 'reduce' });

const HARNESS_URL = 'http://127.0.0.1:5173/tests/browser/floating-board.html?history=off&sidebar=off';
const EXPECTED_SECTIONS = [
  '画布',
  '剪贴板',
  '存储目录',
  '窗口与启动',
  '默认图片打开器',
  '分类管理',
  '插件',
  '外观',
] as const;

type FloatingBoardHarness = {
  calls: {
    settings: Array<Record<string, unknown>>;
    associationReads: number;
    configureAssociation: number;
    directories: Array<string | undefined>;
    pluginLists: number;
    categories: string[];
  };
  desktopSettings: {
    closeBehavior: string;
    autoStart: boolean;
    autoStartAvailable: boolean;
    captureEnabled: boolean;
    historyRetentionDays: number;
    snapToGrid: boolean;
    gridSize: number;
  };
  state: {
    categories: Array<{ id: string; name: string }>;
  };
  failAssociation: boolean;
};

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath('screenshots', `${name}.png`);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path });
  return path;
}

async function openBoardAndEnterSettings(page: Page) {
  await page.goto(HARNESS_URL);
  await expect(page.getByRole('toolbar', { name: '画板工具', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-navigation')).toHaveCount(0);
  await expect(page.locator('.sidebar')).toHaveClass(/closed/);
  await expect(page.getByRole('textbox', { name: '搜索画布' })).toBeHidden();

  await page.locator('.sidebar-toggle').hover();
  await expect(page.locator('.sidebar')).toHaveClass(/is-peeking/);
  await expect(page.getByRole('textbox', { name: '搜索画布' })).toBeVisible();

  const openSettingsBtn = page.getByRole('button', { name: '打开设置', exact: true });
  await expect(openSettingsBtn).toBeVisible();
  await openSettingsBtn.click();

  await expect(page.locator('.sidebar')).toHaveClass(/is-pinned/);
  await expect(page.getByRole('navigation', { name: '设置项目' })).toBeVisible();
  const searchInput = page.getByRole('textbox', { name: '搜索设置' });
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveAttribute('placeholder', '搜索设置…');
  await expect(page.locator('.settings-view h1')).toHaveText('画布');
}

function fieldTrigger(page: Page, label: string, triggerSelector: '.qib-select-trigger' | '.qib-color-trigger'): Locator {
  return page
    .locator('.qib-field')
    .filter({ has: page.locator('.qib-label', { hasText: label }) })
    .locator(triggerSelector);
}

async function assertPopoverVisibleAndHitTested(page: Page, popover: Locator, label: string) {
  await expect(popover).toBeVisible();
  const check = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const layer = element.closest('.qib-popover-layer');
    const inBody = layer?.parentElement === document.body;
    const layerPosition = layer ? getComputedStyle(layer).position : null;
    const fitsViewport =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.right <= window.innerWidth &&
      rect.bottom <= window.innerHeight;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const hitInside = Boolean(hit && element.contains(hit));
    return {
      inBody,
      layerPosition,
      visibility: style.visibility,
      fitsViewport,
      hitInside,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(check.inBody, `${label} popover should portal to document.body`).toBe(true);
  expect(check.layerPosition, `${label} popover layer should be fixed`).toBe('fixed');
  expect(check.visibility, `${label} popover should be visible`).toBe('visible');
  expect(check.fitsViewport, `${label} popover should fit inside viewport: ${JSON.stringify(check)}`).toBe(true);
  expect(check.hitInside, `${label} popover center should receive pointer hit: ${JSON.stringify(check)}`).toBe(true);
}

test('settings entry, 8 independent sections, real option interactions, and return to canvas restores collapsed sidebar', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openBoardAndEnterSettings(page);

  const nav = page.getByRole('navigation', { name: '设置项目' });
  const navButtons = nav.getByRole('button');
  await expect(navButtons).toHaveCount(8);
  await expect(navButtons).toHaveText([...EXPECTED_SECTIONS]);

  // 1. 画布 (Canvas): only canvas controls mounted, modify gridSize via Select
  await expect(page.locator('.settings-view h1')).toHaveText('画布');
  await expect(page.locator('.settings-view .settings-section')).toHaveCount(1);
  await expect(page.getByRole('group', { name: '画布图案' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: '关闭窗口时' })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: '界面主题' })).toHaveCount(0);
  const gridTrigger = fieldTrigger(page, '网格间距', '.qib-select-trigger');
  await expect(gridTrigger).toContainText('24');
  await gridTrigger.click();
  const gridListbox = page.getByRole('listbox', { name: '网格间距' });
  await assertPopoverVisibleAndHitTested(page, gridListbox, '网格间距');
  await gridListbox.getByRole('option', { name: '32', exact: true }).dispatchEvent('mousedown');
  await expect(gridTrigger).toContainText('32');
  await expect.poll(() => page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.desktopSettings.gridSize)).toBe(32);
  await capture(page, testInfo, '01-canvas-section');

  // 2. 剪贴板 (Clipboard): only clipboard controls mounted, toggle captureEnabled & retention Select
  await nav.getByRole('button', { name: '剪贴板', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('剪贴板');
  await expect(page.locator('.settings-view .settings-section')).toHaveCount(1);
  await expect(page.getByRole('group', { name: '画布图案' })).toHaveCount(0);
  const captureCheckbox = page.locator('.settings-toggle input[type="checkbox"]');
  await expect(captureCheckbox).toBeChecked();
  await captureCheckbox.uncheck();
  await expect(captureCheckbox).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.desktopSettings.captureEnabled)).toBe(false);

  // 3. 存储目录 (Storage): only storage controls mounted, pickDirectory updates path
  await nav.getByRole('button', { name: '存储目录', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('存储目录');
  await expect(page.locator('.settings-view .settings-section')).toHaveCount(1);
  await expect(captureCheckbox).toHaveCount(0);
  const pathInput = page.getByRole('textbox', { name: '文件路径（完整路径，可编辑）' });
  await expect(pathInput).toHaveValue('quick-image-board');
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(pathInput).toHaveValue('E:\\PicBoard-test\\images');
  expect(await page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.calls.directories)).toEqual(['quick-image-board']);

  // 4. 窗口与启动 (Window & Startup): radio options 收纳到托盘 / 退出程序
  await nav.getByRole('button', { name: '窗口与启动', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('窗口与启动');
  await expect(page.locator('.settings-view .settings-section')).toHaveCount(1);
  await expect(pathInput).toHaveCount(0);
  const closeGroup = page.getByRole('radiogroup', { name: '关闭窗口时' });
  await expect(closeGroup).toBeVisible();
  const trayRadio = closeGroup.getByRole('radio', { name: '收纳到托盘' });
  const quitRadio = closeGroup.getByRole('radio', { name: '退出程序' });
  await expect(trayRadio).toBeVisible();
  await expect(quitRadio).toBeVisible();
  await trayRadio.click();
  await expect(trayRadio).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.desktopSettings.closeBehavior)).toBe('tray');
  await quitRadio.click();
  await expect(quitRadio).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.desktopSettings.closeBehavior)).toBe('quit');

  // 5. 默认图片打开器 (Default image opener): independent page
  await nav.getByRole('button', { name: '默认图片打开器', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('默认图片打开器');
  await expect(page.locator('.settings-view .settings-section')).toHaveCount(1);
  await expect(closeGroup).toHaveCount(0);
  await expect(page.locator('section.settings-section[aria-label="默认图片打开器"]')).toBeVisible();
  await expect(page.locator('.image-association-button')).toBeVisible();

  // 6. 分类管理 (Categories): add category via prompt dialog
  await nav.getByRole('button', { name: '分类管理', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('分类管理');
  await expect(page.locator('.settings-view .settings-section')).toHaveCount(1);
  await expect(page.locator('.category-chip')).toHaveText(['灵感']);
  await page.getByRole('button', { name: '＋ 新建分类', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '新建分类' });
  await expect(dialog).toBeVisible();
  await dialog.locator('input').fill('UI参考');
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.locator('.category-chip')).toHaveText(['灵感', 'UI参考']);
  expect(await page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.calls.categories)).toEqual(['UI参考']);

  // 7. 插件 (Plugins): initial listPlugins on mount + reload button increments pluginLists
  await nav.getByRole('button', { name: '插件', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('插件');
  await expect(page.locator('.settings-view .settings-section')).toHaveCount(1);
  await expect(page.locator('.category-chip')).toHaveCount(0);
  await expect(page.locator('.plg-directory code')).toHaveText('E:\\PicBoard-test\\plugins');
  const initialPluginCalls = await page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.calls.pluginLists);
  expect(initialPluginCalls).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.calls.pluginLists)).toBe(initialPluginCalls + 1);

  // 8. 外观 (Appearance): radiogroup 界面主题 with 浅色 / 黑夜 / 跟随系统 and root data-theme
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('外观');
  await expect(page.locator('.settings-view .settings-section')).toHaveCount(1);
  await expect(page.locator('.plg-directory')).toHaveCount(0);
  const themeGroup = page.getByRole('radiogroup', { name: '界面主题' });
  await expect(themeGroup).toBeVisible();
  const lightRadio = themeGroup.getByRole('radio', { name: '浅色', exact: true });
  const darkRadio = themeGroup.getByRole('radio', { name: '黑夜', exact: true });
  const systemRadio = themeGroup.getByRole('radio', { name: '跟随系统', exact: true });
  await expect(systemRadio).toBeChecked();
  await darkRadio.check();
  await expect(darkRadio).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await lightRadio.check();
  await expect(lightRadio).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await systemRadio.check();
  await expect(systemRadio).toBeChecked();
  await capture(page, testInfo, '02-appearance-section');

  // Exit settings via 返回画布 and verify board sidebar preference (collapsed) is restored
  await page.getByRole('button', { name: '返回画布', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: '画板工具', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveClass(/closed/);
  expect(await page.evaluate(() => localStorage.getItem('quick-image-board.sidebar-collapsed'))).toBe('1');
});

test('settings search filters navigation only, preserves query across section clicks, and keeps current page on no results', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openBoardAndEnterSettings(page);

  const nav = page.getByRole('navigation', { name: '设置项目' });
  const searchInput = page.getByRole('textbox', { name: '搜索设置' });

  // Start on 画布, search for "历史" (matches 剪贴板)
  await expect(page.locator('.settings-view h1')).toHaveText('画布');
  await searchInput.fill('历史');
  await expect(nav.getByRole('button')).toHaveText(['剪贴板']);
  // Right page remains 画布 until user clicks a filtered item
  await expect(page.locator('.settings-view h1')).toHaveText('画布');
  await expect(page.getByRole('group', { name: '画布图案' })).toBeVisible();

  // Clicking filtered item switches page and keeps query
  await nav.getByRole('button', { name: '剪贴板', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('剪贴板');
  await expect(searchInput).toHaveValue('历史');
  await expect(nav.getByRole('button')).toHaveText(['剪贴板']);

  // Search with multiple matches and switch while keeping query
  await searchInput.fill('外观');
  await expect(nav.getByRole('button')).toHaveText(['画布', '外观']);
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('外观');
  await expect(searchInput).toHaveValue('外观');
  await expect(nav.getByRole('button')).toHaveText(['画布', '外观']);

  // No results keeps current right page (外观)
  await searchInput.fill('不存在的设置关键词xyz');
  await expect(nav.getByRole('button')).toHaveCount(0);
  await expect(nav.getByRole('status')).toContainText('没有匹配的设置项目');
  await expect(page.locator('.settings-view h1')).toHaveText('外观');
  await capture(page, testInfo, '03-search-no-results');
});

test('default image opener configures association, refreshes registered state, and surfaces host error without fake success', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openBoardAndEnterSettings(page);

  const nav = page.getByRole('navigation', { name: '设置项目' });
  await nav.getByRole('button', { name: '默认图片打开器', exact: true }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('默认图片打开器');

  const actionBtn = page.locator('.image-association-button');
  await expect(actionBtn).toBeEnabled();
  await expect(actionBtn).toHaveText('设为默认图片应用');
  expect(await page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.calls.associationReads)).toBe(1);

  // 1. Failure path first: failAssociation = true -> presents error, does not fake registered state or success message
  await page.evaluate(() => {
    (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.failAssociation = true;
  });
  await actionBtn.click();
  await expect(page.locator('.qib-shell-error[role="alert"]')).toHaveText('测试默认应用设置打开失败');
  await expect(actionBtn).toHaveText('设为默认图片应用');
  await expect(page.getByText('已打开 Windows 默认应用设置')).toHaveCount(0);
  await expect(page.getByText('PicBoard 已注册图片打开能力')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.calls.configureAssociation)).toBe(1);
  await capture(page, testInfo, '04-image-opener-error');

  // 2. Success path: failAssociation = false -> calls configureImageAssociation and refreshes registered state
  await page.evaluate(() => {
    (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.failAssociation = false;
  });
  await actionBtn.click();
  await expect(page.locator('.qib-shell-error[role="alert"]')).toHaveCount(0);
  await expect(actionBtn).toHaveText('管理默认图片应用');
  await expect(page.getByText('PicBoard 已注册图片打开能力，默认关联由 Windows 中的选择决定。')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('已打开 Windows 默认应用设置');
  const counts = await page.evaluate(() => {
    const fb = (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard;
    return { reads: fb.calls.associationReads, configures: fb.calls.configureAssociation };
  });
  expect(counts.configures).toBe(2);
  expect(counts.reads).toBe(2);
  await capture(page, testInfo, '05-image-opener-registered');
});

test('Ctrl+K focuses contextual search on noneditable target and does not hijack when editing text input', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(HARNESS_URL);
  await expect(page.getByRole('toolbar', { name: '画板工具', exact: true })).toBeVisible();

  // Start closed: the shortcut must commit the visible drawer before focusing its input.
  await expect(page.locator('.sidebar')).toHaveClass(/closed/);
  await page.locator('.canvas-viewport').click({ position: { x: 450, y: 20 } });
  const canvasSearch = page.getByRole('textbox', { name: '搜索画布' });
  await page.keyboard.press('Control+k');
  await expect(canvasSearch).toBeFocused();

  // Open settings
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const settingsSearch = page.getByRole('textbox', { name: '搜索设置' });
  await expect(settingsSearch).toBeVisible();

  // Move focus to a noneditable button in settings
  const nav = page.getByRole('navigation', { name: '设置项目' });
  const storageNavBtn = nav.getByRole('button', { name: '存储目录', exact: true });
  await storageNavBtn.click();
  await storageNavBtn.focus();
  await expect(storageNavBtn).toBeFocused();

  // Ctrl+K from noneditable target focuses 搜索设置
  await page.keyboard.press('Control+k');
  await expect(settingsSearch).toBeFocused();

  // Focus an editable text input (storage directory input) and verify Ctrl+K does NOT steal focus
  const pathInput = page.getByRole('textbox', { name: '文件路径（完整路径，可编辑）' });
  await pathInput.click();
  await expect(pathInput).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(pathInput).toBeFocused();
  await expect(settingsSearch).not.toBeFocused();
});

test('narrow 720x480 viewport keeps settings navigation reachable and all Select and ColorPicker popovers fit viewport without clipping', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await openBoardAndEnterSettings(page);

  const nav = page.getByRole('navigation', { name: '设置项目' });
  for (const label of EXPECTED_SECTIONS) {
    const btn = nav.getByRole('button', { name: label, exact: true });
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeVisible();
    expect(await btn.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }), `${label} is not covered by the footer or clipped navigation`).toBe(true);
  }

  await expect(page.locator(".sidebar-footer")).toBeInViewport({ ratio: 1 });
  // Switch to 外观 (last nav item) and back to 画布 at 720x480 to prove reachability/usability
  const appearanceBtn = nav.getByRole('button', { name: '外观', exact: true });
  await appearanceBtn.scrollIntoViewIfNeeded();
  await appearanceBtn.click();
  await expect(page.locator('.settings-view h1')).toHaveText('外观');

  const canvasBtn = nav.getByRole('button', { name: '画布', exact: true });
  await canvasBtn.scrollIntoViewIfNeeded();
  await canvasBtn.click();
  await expect(page.locator('.settings-view h1')).toHaveText('画布');

  // 1. Select: 网格间距
  const gridTrigger = fieldTrigger(page, '网格间距', '.qib-select-trigger');
  await gridTrigger.scrollIntoViewIfNeeded();
  await gridTrigger.click();
  const gridListbox = page.getByRole('listbox', { name: '网格间距' });
  await assertPopoverVisibleAndHitTested(page, gridListbox, '网格间距 (720x480)');
  await capture(page, testInfo, '06-narrow-select-grid');
  await page.keyboard.press('Escape');
  await expect(gridListbox).toHaveCount(0);

  // 2. ColorPicker: 背景颜色
  const bgColorTrigger = fieldTrigger(page, '背景颜色', '.qib-color-trigger');
  await bgColorTrigger.scrollIntoViewIfNeeded();
  await bgColorTrigger.click();
  const bgColorDialog = page.getByRole('dialog', { name: '背景颜色' });
  await assertPopoverVisibleAndHitTested(page, bgColorDialog, '背景颜色 (720x480)');
  await capture(page, testInfo, '07-narrow-color-background');
  await page.keyboard.press('Escape');
  await expect(bgColorDialog).toHaveCount(0);

  // 3. ColorPicker: 图案颜色
  const patternColorTrigger = fieldTrigger(page, '图案颜色', '.qib-color-trigger');
  await patternColorTrigger.scrollIntoViewIfNeeded();
  await patternColorTrigger.click();
  const patternColorDialog = page.getByRole('dialog', { name: '图案颜色' });
  await assertPopoverVisibleAndHitTested(page, patternColorDialog, '图案颜色 (720x480)');
  await capture(page, testInfo, '08-narrow-color-pattern');
  await page.keyboard.press('Escape');
  await expect(patternColorDialog).toHaveCount(0);

  // 4. Select: 历史保留时间 (on 剪贴板 section)
  const clipboardBtn = nav.getByRole('button', { name: '剪贴板', exact: true });
  await clipboardBtn.scrollIntoViewIfNeeded();
  await clipboardBtn.click();
  await expect(page.locator('.settings-view h1')).toHaveText('剪贴板');
  const retentionTrigger = fieldTrigger(page, '历史保留时间', '.qib-select-trigger');
  await retentionTrigger.scrollIntoViewIfNeeded();
  await retentionTrigger.click();
  const retentionListbox = page.getByRole('listbox', { name: '历史保留时间' });
  await assertPopoverVisibleAndHitTested(page, retentionListbox, '历史保留时间 (720x480)');
  await retentionListbox.getByRole('option', { name: '90 天', exact: true }).dispatchEvent('mousedown');
  await expect(retentionTrigger).toContainText('90 天');
  await expect.poll(() => page.evaluate(() => (window as unknown as { floatingBoard: FloatingBoardHarness }).floatingBoard.desktopSettings.historyRetentionDays)).toBe(90);
  await capture(page, testInfo, '09-narrow-select-retention');
});

async function renderedColors(locator: Locator) {
  return locator.evaluate(element => {
    const rgba = (value: string) => value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
    let owner: Element | null = element;
    while (owner && (rgba(getComputedStyle(owner).backgroundColor)[3] ?? 1) === 0) owner = owner.parentElement;
    const background = rgba(owner ? getComputedStyle(owner).backgroundColor : 'rgb(255, 255, 255)');
    const text = rgba(getComputedStyle(element).color);
    const brightness = (color: number[]) => .2126 * color[0] + .7152 * color[1] + .0722 * color[2];
    return { background: brightness(background), text: brightness(text) };
  });
}

test('appearance changes rendered surfaces, text and popovers while preserving a custom canvas background', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await openBoardAndEnterSettings(page);
  const nav = page.getByRole('navigation', { name: '设置项目' });
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('radio', { name: '浅色', exact: true }).check();
  const surfaces = ['.app-shell', '.settings-section', '.sidebar-search input'];
  const light = await Promise.all(surfaces.map(selector => renderedColors(page.locator(selector).first())));
  await nav.getByRole('button', { name: '画布', exact: true }).click();
  await fieldTrigger(page, '背景颜色', '.qib-color-trigger').click();
  const lightPopup = await renderedColors(page.getByRole('dialog', { name: '背景颜色' }));
  await page.keyboard.press('Escape');
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('radio', { name: '黑夜', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const [index, selector] of surfaces.entries()) {
    const dark = await renderedColors(page.locator(selector).first());
    expect(dark.background, `${selector} background becomes darker`).toBeLessThan(light[index].background - 80);
    expect(dark.text, `${selector} text becomes lighter`).toBeGreaterThan(light[index].text + 60);
  }
  await capture(page, testInfo, '10-dark-appearance');
  await nav.getByRole('button', { name: '画布', exact: true }).click();
  const defaultCanvas = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim().toLowerCase());
  await expect(fieldTrigger(page, '背景颜色', '.qib-color-trigger')).toContainText(defaultCanvas);
  await fieldTrigger(page, '背景颜色', '.qib-color-trigger').click();
  const darkPopup = page.getByRole('dialog', { name: '背景颜色' });
  await assertPopoverVisibleAndHitTested(page, darkPopup, 'dark background color');
  expect((await renderedColors(darkPopup)).background).toBeLessThan(lightPopup.background - 80);
  await capture(page, testInfo, '11-dark-color-popover');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '返回画布', exact: true }).click();
  expect((await renderedColors(page.locator('.canvas-viewport'))).background).toBeLessThan(80);

  // An explicit user color survives theme changes; only untouched defaults follow the palette.
  await page.locator('.sidebar-toggle').hover();
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await nav.getByRole('button', { name: '画布', exact: true }).click();
  await page.getByRole('button', { name: '背景米色', exact: true }).click();
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('radio', { name: '浅色', exact: true }).check();
  await page.getByRole('radio', { name: '黑夜', exact: true }).check();
  await page.getByRole('button', { name: '返回画布', exact: true }).click();
  await expect(page.locator('.canvas-viewport')).toHaveCSS('background-color', 'rgb(241, 238, 230)');
  await capture(page, testInfo, '12-dark-custom-canvas-preserved');
});
