import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 420, height: 600 }, reducedMotion: 'reduce' });

test('the tray keeps all content filters on one line and gives search the remaining space', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/tests/browser/floating-board.html?surface=tray');
  const filters = page.getByRole('group', { name: '内容类型' });
  const buttons = filters.getByRole('button');
  const search = page.getByRole('textbox', { name: '搜索内容' });
  await expect(filters.getByRole('button', { name: /^全部\s*3$/ })).toBeVisible();
  await expect(buttons).toHaveCount(4);

  const nativeLayout = await filters.boundingBox();
  const nativeSearch = await search.boundingBox();
  expect(nativeLayout).not.toBeNull();
  expect(nativeSearch).not.toBeNull();
  expect(nativeSearch!.x).toBeGreaterThan(nativeLayout!.x + nativeLayout!.width);
  expect(Math.abs(nativeSearch!.y + nativeSearch!.height / 2 - nativeLayout!.y - nativeLayout!.height / 2)).toBeLessThan(1);
  const nativeRows = await buttons.evaluateAll((elements) => elements.map((button) => button.getBoundingClientRect().top));
  expect(Math.max(...nativeRows) - Math.min(...nativeRows)).toBeLessThan(1);

  await page.setViewportSize({ width: 320, height: 600 });
  const narrowLayout = await filters.boundingBox();
  const narrowSearch = await search.boundingBox();
  expect(narrowSearch!.y).toBeGreaterThan(narrowLayout!.y + narrowLayout!.height);
  const narrowRows = await buttons.evaluateAll((elements) => elements.map((button) => button.getBoundingClientRect().top));
  expect(Math.max(...narrowRows) - Math.min(...narrowRows)).toBeLessThan(1);
  await filters.getByRole('button', { name: /^链接/ }).click();
  await expect(page.getByRole('button', { name: /^链接：/ })).toBeVisible();
});
