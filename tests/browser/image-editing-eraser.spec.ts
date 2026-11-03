import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/tests/browser/image-editing.html');
});

async function mount(page: Page, options = {}) {
  await page.evaluate(async options => { await (window as any).mountEditing(options); }, options);
  await expect(page.getByRole('button', { name: '保存副本', exact: true })).toBeEnabled();
}
async function drag(page: Page, name: string, from: [number, number], to: [number, number], finish = true) {
  await page.getByRole('button', { name, exact: true }).click();
  const canvas = page.getByLabel('图片编辑画布'), box = (await canvas.boundingBox())!;
  const dimensions = await canvas.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height }));
  const at = ([x, y]: [number, number]) => ({ x: box.x + x * box.width / dimensions.width, y: box.y + y * box.height / dimensions.height });
  const a = at(from), b = at(to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 });
  if (finish) await page.mouse.up();
}
async function pixel(page: Page, x: number, y: number) {
  return page.getByLabel('图片编辑画布').evaluate((canvas: HTMLCanvasElement, point) => Array.from(canvas.getContext('2d')!.getImageData(point.x, point.y, 1, 1).data), { x, y });
}

for (const kind of ['pen', 'arrow', 'rectangle', 'text', 'mosaic'] as const) {
  test(`eraser restores every original pixel of ${kind} without whitening the base`, async ({ page }) => {
    const result = await page.evaluate(async kind => {
      const { renderImageEdits } = await import('/renderer/src/pages/image-editing.ts');
      const source = document.createElement('canvas'); source.width = 96; source.height = 72;
      const context = source.getContext('2d')!;
      for (let y = 0; y < 72; y++) for (let x = 0; x < 96; x++) {
        context.fillStyle = (x + y) % 2 ? '#11588b' : '#d3b85a'; context.fillRect(x, y, 1, 1);
      }
      const mark = kind === 'mosaic' ? { kind, rect: { x: 5, y: 5, width: 80, height: 60 }, size: 24 }
        : kind === 'text' ? { kind, point: { x: 10, y: 10 }, text: 'Erase', color: '#ff0000', size: 28 }
        : { kind, points: [{ x: 12, y: 16 }, { x: 76, y: 52 }], color: '#ff0000', size: 10 };
      const before = renderImageEdits(source, 96, 72, [mark] as any);
      const erased = renderImageEdits(source, 96, 72, [mark, { kind: 'eraser', points: [{ x: 48, y: 36 }], size: 240 }] as any);
      const original = context.getImageData(0, 0, 96, 72).data;
      const changed = before.getContext('2d')!.getImageData(0, 0, 96, 72).data;
      const restored = erased.getContext('2d')!.getImageData(0, 0, 96, 72).data;
      return { changed: original.some((value, index) => value !== changed[index]), exact: original.every((value, index) => value === restored[index]) };
    }, kind);
    expect(result).toEqual({ changed: true, exact: true });
  });
}

test('a curved eraser path clears only its swept area and can preview without changing committed layers', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderImageEditLayers, compositeImageLayers } = await import('/renderer/src/pages/image-editing.ts');
    const source = document.createElement('canvas'); source.width = 96; source.height = 64;
    const context = source.getContext('2d')!; context.fillStyle = '#11588b'; context.fillRect(0, 0, 96, 64);
    const layers = renderImageEditLayers(source, 96, 64, [{ kind: 'pen', points: [{ x: 8, y: 16 }, { x: 88, y: 16 }], size: 10, color: '#ff0000' }]);
    const preview = compositeImageLayers(layers, { kind: 'eraser', points: [{ x: 24, y: 0 }, { x: 24, y: 32 }, { x: 64, y: 32 }], size: 12 });
    const committed = compositeImageLayers(layers);
    const at = (canvas: HTMLCanvasElement, x: number) => Array.from(canvas.getContext('2d')!.getImageData(x, 16, 1, 1).data);
    return { erased: at(preview, 24), untouched: at(preview, 44), committed: at(committed, 24) };
  });
  expect(result).toEqual({ erased: [17, 88, 139, 255], untouched: [255, 0, 0, 255], committed: [255, 0, 0, 255] });
});

test('erasing after crop, rotate and flip uses the transformed image coordinates, including replay undo/redo', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderImageEdits } = await import('/renderer/src/pages/image-editing.ts');
    const source = document.createElement('canvas'); source.width = 80; source.height = 60;
    const context = source.getContext('2d')!;
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) {
      context.fillStyle = `rgb(${x * 3},${y * 4},100)`; context.fillRect(x, y, 1, 1);
    }
    const transforms = [{ kind: 'crop', rect: { x: 8, y: 8, width: 48, height: 40 } }, { kind: 'rotate' }, { kind: 'flip' }];
    const edits = [{ kind: 'pen', points: [{ x: 10, y: 16 }, { x: 45, y: 16 }], size: 10, color: '#ff0000' }, ...transforms,
      { kind: 'eraser', points: [{ x: 8.5, y: 16.5 }], size: 12 }];
    const at = (canvas: HTMLCanvasElement) => Array.from(canvas.getContext('2d')!.getImageData(8, 16, 1, 1).data);
    const output = renderImageEdits(source, 80, 60, edits as any);
    const undo = renderImageEdits(source, 80, 60, edits.slice(0, -1) as any);
    const eraseFirst = renderImageEdits(source, 80, 60, [edits[0], { kind: 'eraser', points: [{ x: 24.5, y: 16.5 }], size: 12 }, ...transforms] as any);
    return { dimensions: [output.width, output.height], original: Array.from(context.getImageData(24, 16, 1, 1).data), erased: at(output), undo: at(undo), eraseFirst: at(eraseFirst) };
  });
  expect(result.dimensions).toEqual([40, 48]);
  expect(result.erased).toEqual(result.original);
  expect(result.eraseFirst).toEqual(result.original);
  expect(result.undo).toEqual([255, 0, 0, 255]);
});

test('transparent mosaic replaces pixels without doubling alpha, and erasure recovers transparent and translucent base pixels', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderImageEdits } = await import('/renderer/src/pages/image-editing.ts');
    const source = document.createElement('canvas'); source.width = 32; source.height = 32;
    const context = source.getContext('2d')!;
    context.fillStyle = '#33669980'; context.fillRect(16, 0, 16, 32);
    const mosaic = { kind: 'mosaic', rect: { x: 0, y: 0, width: 32, height: 32 }, size: 64 } as const;
    const output = renderImageEdits(source, 32, 32, [mosaic]);
    const erased = renderImageEdits(source, 32, 32, [mosaic, { kind: 'eraser', points: [{ x: 16, y: 16 }], size: 120 }]);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    const restored = erased.getContext('2d')!.getImageData(0, 0, 32, 32).data;
    const at = (x: number) => Array.from(output.getContext('2d')!.getImageData(x, 16, 1, 1).data);
    return { left: at(4), right: at(28), exact: pixels.every((value, index) => value === restored[index]) };
  });
  expect(result.left).toEqual(result.right);
  expect(result.left[3]).toBe(64);
  expect(result.exact).toBe(true);
});

test('live erasing previews restored pixels, pointer cancellation discards preview, and undo/redo recover the stroke', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await mount(page);
  const original = await pixel(page, 100, 30);
  await drag(page, '画笔', [20, 30], [200, 30]);
  expect(await pixel(page, 100, 30)).not.toEqual(original);
  await drag(page, '橡皮擦', [100, 20], [100, 40], false);
  await expect(page.getByTestId('ime-eraser-cursor')).toBeVisible();
  expect(await pixel(page, 100, 30)).toEqual(original);
  await page.getByLabel('图片编辑画布').dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  expect(await pixel(page, 100, 30)).not.toEqual(original);
  await drag(page, '橡皮擦', [100, 20], [100, 40]);
  expect(await pixel(page, 100, 30)).toEqual(original);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await pixel(page, 100, 30)).not.toEqual(original);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await pixel(page, 100, 30)).toEqual(original);
  // A new operation after undo drops only the redo branch.
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await drag(page, '画笔', [20, 60], [200, 60]);
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeDisabled();
});

test('visible mosaic, transformed erasing and PNG export preserve the exact restored pixels on a scaled canvas', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await mount(page, { width: 400, height: 300 });
  const original = await pixel(page, 100, 80);
  await drag(page, '马赛克', [60, 40], [200, 160]);
  expect(await page.getByLabel('图片编辑画布').evaluate((node: HTMLCanvasElement) => { const pixels = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data; return pixels.some((value, index) => value !== (window as any).originalPixels[index]); })).toBe(true);
  await drag(page, '裁剪', [20, 20], [300, 220]);
  await page.getByRole('button', { name: '应用裁剪', exact: true }).click();
  const canvas = page.getByLabel('图片编辑画布');
  await expect(canvas).toHaveAttribute('width', '280');
  await page.getByRole('button', { name: '旋转', exact: true }).click();
  await page.getByRole('button', { name: '翻转', exact: true }).click();
  await expect(canvas).toHaveAttribute('width', '200');
  await expect(canvas).toHaveAttribute('height', '280');
  // Clockwise rotation followed by horizontal flip maps (x,y) to (y,x).
  await drag(page, '橡皮擦', [60, 70], [60, 90]);
  expect(await pixel(page, 60, 80)).toEqual(original);
  await page.getByRole('button', { name: '导出文件', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).exportedImage?.data.length ?? 0)).toBeGreaterThan(0);
  const result = await page.evaluate(async () => {
    const payload = (window as any).exportedImage;
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(payload.data)]));
    const output = document.createElement('canvas'); output.width = bitmap.width; output.height = bitmap.height;
    output.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close();
    return { name: payload.name, width: output.width, height: output.height, pixel: Array.from(output.getContext('2d')!.getImageData(60, 80, 1, 1).data) };
  });
  expect(result).toEqual({ name: '原图-编辑.png', width: 200, height: 280, pixel: original });
});

for (const host of ['host', 'null', 'undefined']) {
  test(`the local icon toolbar stays visible with toolbarHost=${host} and exposes labels and tooltips`, async ({ page }) => {
    await mount(page, { host });
    await expect(page.locator('#toolbar')).toBeEmpty();
    await expect(page.locator('.ime-editor').getByRole('toolbar', { name: '图像编辑工具' })).toBeVisible();
    for (const name of ['批注颜色', '画笔', '橡皮擦', '箭头', '方框', '文字', '裁剪', '马赛克', '撤销', '重做', '旋转', '翻转', '取消', '导出文件']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toHaveAttribute('title', /.+/);
      if (name !== '批注颜色') await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    await page.getByRole('button', { name: '橡皮擦', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '橡皮擦', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('slider', { name: '橡皮擦大小' })).toBeVisible();
  });
}

for (const [width, height] of [[1280, 720], [720, 480], [480, 360], [320, 360]]) {
  test(`floating capsules fit ${width}x${height}, keep the canvas background and never cover the image`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await mount(page, { width: 800, height: 600 });
    await page.getByRole('button', { name: '文字', exact: true }).click();
    await page.getByRole('textbox', { name: '批注文字' }).fill('紧凑工具栏');
    await page.getByRole('combobox', { name: '导出格式' }).selectOption('jpeg');
    await expect.poll(async () => page.evaluate(() => {
      const editor = document.querySelector('.ime-editor')!, dock = document.querySelector('.ime-dock')!, surface = document.querySelector('.ime-surface')!, hint = document.querySelector('.ime-hint')!;
      const r = editor.getBoundingClientRect(), d = dock.getBoundingClientRect(), s = surface.getBoundingClientRect(), h = hint.getBoundingClientRect();
      return s.bottom <= h.top && h.bottom < d.top && d.bottom <= r.bottom;
    })).toBe(true);
    const layout = await page.evaluate(() => {
      const editor = document.querySelector('.ime-editor')!, dock = document.querySelector('.ime-dock')!, toolbar = document.querySelector('.ime-toolbar')!;
      const r = editor.getBoundingClientRect(), d = dock.getBoundingClientRect(), t = toolbar.getBoundingClientRect();
      const controls = Array.from(toolbar.querySelectorAll('button, input, select')).map(node => node.getBoundingClientRect());
      return {
        centered: Math.abs((t.left + t.right) / 2 - (r.left + r.right) / 2) < 1,
        contained: controls.every(c => c.left >= r.left && c.right <= r.right && c.bottom <= r.bottom && c.top >= d.top),
        overflow: document.documentElement.scrollWidth > innerWidth,
        position: getComputedStyle(dock).position, background: getComputedStyle(dock).backgroundColor,
        pattern: getComputedStyle(editor).backgroundImage,
      };
    });
    expect(layout).toMatchObject({ centered: true, contained: true, overflow: false, position: 'absolute', background: 'rgba(0, 0, 0, 0)' });
    expect(layout.pattern).toContain('radial-gradient');
    await page.screenshot({ path: testInfo.outputPath(`image-editing-${width}.png`) });
  });
}

test('save awaits the integration callback and blocks navigation or discard until it settles', async ({ page }) => {
  await mount(page, { holdSave: true });
  await page.getByRole('button', { name: '旋转', exact: true }).click();
  await page.getByRole('button', { name: '保存副本', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishSave)).toBe('function');
  await expect(page.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
  const blocked = await page.evaluate(async () => {
    const api = (window as any).editorApi.current;
    return { close: api.closePopups(), beforeClose: await api.beforeClose() };
  });
  expect(blocked).toEqual({ close: true, beforeClose: false });
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).cancelled)).toBeUndefined();
  await page.evaluate(() => (window as any).finishSave());
  await expect.poll(() => page.evaluate(() => (window as any).saved)).toBe(true);
  await expect(page.getByRole('button', { name: '保存副本', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).savedResult)).toEqual({ state: { marker: 'copy' }, contentId: 'edited' });
});

test('a rejected save integration callback reports the error and re-enables editing', async ({ page }) => {
  await mount(page, { holdSave: true });
  await page.getByRole('button', { name: '保存副本', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).rejectSave)).toBe('function');
  await page.evaluate(() => (window as any).rejectSave());
  await expect.poll(() => page.evaluate(() => (window as any).editorError)).toBe('放置失败');
  await expect(page.getByRole('button', { name: '保存副本', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '橡皮擦', exact: true })).toBeEnabled();
});

test('discard confirmation remains available and a cancelled export leaves the edits open', async ({ page }) => {
  await mount(page, { cancelExport: true });
  await drag(page, '画笔', [20, 30], [200, 30]);
  await page.getByRole('button', { name: '导出文件', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).exportedImage))).toBe(true);
  expect(await page.evaluate(() => (window as any).editorNotice)).toBeUndefined();
  await expect(page.getByRole('button', { name: '保存副本', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '放弃图片编辑' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).cancelled)).toBeUndefined();
});


test('post-transform strokes use current coordinates and eraser edge pixels retain an opaque base', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderImageEdits } = await import('/renderer/src/pages/image-editing.ts');
    const source = document.createElement('canvas'); source.width = 80; source.height = 60;
    const context = source.getContext('2d')!; context.fillStyle = '#11588b'; context.fillRect(0, 0, 80, 60);
    const transforms = [{ kind: 'rotate' }, { kind: 'flip' }] as const;
    const stroke = { kind: 'pen', points: [{ x: 10, y: 40 }, { x: 50, y: 40 }], size: 13, color: '#ff0000' } as const;
    const painted = renderImageEdits(source, 80, 60, [...transforms, stroke] as any);
    const erased = renderImageEdits(source, 80, 60, [...transforms, stroke, { kind: 'eraser', points: [{ x: 30.25, y: 40.25 }], size: 11.5 }] as any);
    const pixels = erased.getContext('2d')!.getImageData(0, 0, 60, 80).data;
    const at = (image: HTMLCanvasElement, x: number, y: number) => Array.from(image.getContext('2d')!.getImageData(x, y, 1, 1).data);
    return { painted: at(painted, 30, 40), restored: at(erased, 30, 40), intact: at(erased, 16, 40), opaque: pixels.every((value, index) => index % 4 !== 3 || value === 255) };
  });
  expect(result).toEqual({ painted: [255, 0, 0, 255], restored: [17, 88, 139, 255], intact: [255, 0, 0, 255], opaque: true });
});
