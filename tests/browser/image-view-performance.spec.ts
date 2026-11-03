import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

interface Sample { name: string; width: number; height: number; mime: string; bytes: number }
interface Timing { firstFrameMs: number; fullOpacityMs: number; decodeMs: number; width: number; height: number; source: string; transferSize: number; encodedBodySize: number; responseMs: number | null }
interface Bench { arm(): void; result(): Promise<Timing> }
const cases = [
  { name: '1080p.png', width: 1920, height: 1080, mime: 'image/png' },
  { name: '4k.png', width: 3840, height: 2160, mime: 'image/png' },
  { name: '24mp.jpg', width: 6000, height: 4000, mime: 'image/jpeg' },
];
const baselineRevision = process.env.PICBOARD_IMAGE_VIEW_BASELINE_REV || 'v0.2.0';
const assets = resolve('test-results/image-performance-assets');
let baselineModule: string | null = null;
const samples: Sample[] = [];
const measurements: Array<Timing & { sample: string; iteration: number; cache: 'cold' | 'repeat' }> = [];

test.beforeAll(async ({ browser }) => {
  if (process.env.PICBOARD_IMAGE_VIEW_BASELINE === '1') {
    const source = execFileSync('git', ['show', `${baselineRevision}:renderer/src/pages/ImageContentPage.tsx`], { encoding: 'utf8' });
    const shims: Record<string, string> = {
      react: 'import value from "http://127.0.0.1:5173/node_modules/.vite/deps/react.js"; export const {useCallback,useEffect,useLayoutEffect,useRef,useState}=value; export default value;',
      'react-dom': 'import value from "http://127.0.0.1:5173/node_modules/.vite/deps/react-dom.js"; export const {createPortal}=value;',
      'react/jsx-runtime': 'import value from "http://127.0.0.1:5173/node_modules/.vite/deps/react_jsx-runtime.js"; export const {jsx,jsxs,Fragment}=value;',
    };
    const result = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: resolve('renderer/src/pages') },
      bundle: true, write: false, format: 'esm', jsx: 'automatic', plugins: [{ name: 'reuse-vite-react-instance', setup(builder) {
        builder.onResolve({ filter: /^react(?:-dom|\/jsx-runtime)?$/ }, args => ({ path: args.path, namespace: 'react-shim' }));
        builder.onLoad({ filter: /.*/, namespace: 'react-shim' }, args => ({ contents: shims[args.path], loader: 'js' }));
      } }] });
    baselineModule = result.outputFiles[0].text;
  }
  await mkdir(assets, { recursive: true });
  const page = await browser.newPage();
  for (const sample of cases) {
    const file = resolve(assets, sample.name);
    let bytes = await stat(file).then(value => value.size).catch(() => 0);
    if (!bytes) {
      const base64 = await page.evaluate(async ({ width, height, mime }) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d')!; const pixels = ctx.createImageData(width, height);
        let seed = 19871203;
        for (let index = 0; index < pixels.data.length; index += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
          const noise = (seed >>> 24) & 63, x = (index / 4) % width, y = Math.floor(index / 4 / width);
          pixels.data[index] = (x * 128 / width + noise + 40) & 255;
          pixels.data[index + 1] = (y * 128 / height + noise + 45) & 255;
          pixels.data[index + 2] = ((x + y) * 100 / (width + height) + noise + 65) & 255;
          pixels.data[index + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        ctx.font = `${Math.round(width / 24)}px sans-serif`; ctx.fillStyle = '#fff';
        ctx.fillText(`${width} × ${height} full resolution`, width / 12, height / 2);
        const blob = await new Promise<Blob>(done => canvas.toBlob(blob => done(blob!), mime, .95));
        return new Promise<string>(done => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).split(',')[1]); reader.readAsDataURL(blob); });
      }, sample);
      const data = Buffer.from(base64, 'base64'); await writeFile(file, data); bytes = data.length;
    }
    samples.push({ ...sample, bytes });
  }
  await page.close();
});

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => console.log(`VIEWER_PAGE_ERROR ${error.message}`));
  if (baselineModule) await page.route('**/renderer/src/pages/ImageContentPage.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: baselineModule! }));
});

test.afterAll(async ({ browser }) => {
  const phase = process.env.PICBOARD_IMAGE_PERF_PHASE || 'current';
  const report = { phase, viewer: baselineModule ? `viewer at ${baselineRevision} injected over module request; working App unchanged` : 'current working viewer', edgeVersion: browser.version(), conditions: { viewport: '1000x700', motion: 'normal', cold: 'CDP HTTP cache disabled, unique original URL, no full-image preload', repeat: 'same URL reopened after closing viewer; HTTP cache enabled', source: 'deterministic textured PNG/JPEG files over Vite local HTTP; App and real viewer with mock metadata host; native custom protocol is outside browser timings' }, samples, measurements };
  await writeFile(resolve(`test-results/image-performance-${phase}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase, samples, measurements: measurements.map(({ sample, iteration, cache, firstFrameMs, fullOpacityMs, decodeMs, transferSize }) => ({ sample, iteration, cache, firstFrameMs, fullOpacityMs, decodeMs, transferSize })) }, null, 2));
});

async function measure(page: Page): Promise<Timing> {
  await page.evaluate(() => (window as unknown as { imageViewBenchmark: Bench }).imageViewBenchmark.arm());
  await page.locator('[data-node-id="perf-node"]').dblclick();
  return page.evaluate(() => (window as unknown as { imageViewBenchmark: Bench }).imageViewBenchmark.result());
}

for (const sampleCase of cases) {
  test(`${sampleCase.name}: cold HTTP open and repeat keep full resolution within 1 second`, async ({ page, context }) => {
    const sample = samples.find(value => value.name === sampleCase.name)!;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    for (let iteration = 1; iteration <= 3; iteration++) {
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      const imageUrl = `/test-results/image-performance-assets/${sample.name}?cold=${Date.now()}-${iteration}`;
      const value = { ...sample, url: imageUrl };
      await page.goto(`http://127.0.0.1:5173/tests/fixtures/floating-image-performance.html?sample=${encodeURIComponent(JSON.stringify(value))}`);
      await expect(page.locator('[data-node-id="perf-node"]')).toBeVisible();
      const request = page.waitForRequest(request => request.url().includes('/image-performance-assets/'));
      const cold = await measure(page); await request;
      measurements.push({ ...cold, sample: sample.name, iteration, cache: 'cold' });
      expect(cold.source).toContain('http://127.0.0.1:5173/test-results/');
      expect(cold.transferSize).toBeGreaterThan(sample.bytes * .95);
      expect(cold.width).toBe(sample.width); expect(cold.height).toBe(sample.height);
      expect(cold.firstFrameMs).toBeGreaterThanOrEqual(cold.decodeMs);
      expect(cold.fullOpacityMs).toBeGreaterThanOrEqual(cold.decodeMs);
      expect(cold.decodeMs).toBeLessThanOrEqual(1000);
      expect(cold.firstFrameMs).toBeLessThanOrEqual(1000);
      expect(cold.fullOpacityMs).toBeLessThanOrEqual(1000);
      await page.keyboard.press('Escape'); await expect(page.locator('.page-layer')).toHaveCount(0);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
      const repeat = await measure(page);
      measurements.push({ ...repeat, sample: sample.name, iteration, cache: 'repeat' });
      expect(repeat.width).toBe(sample.width); expect(repeat.height).toBe(sample.height);
      expect(repeat.firstFrameMs).toBeGreaterThanOrEqual(repeat.decodeMs);
      expect(repeat.fullOpacityMs).toBeGreaterThanOrEqual(repeat.decodeMs);
      expect(repeat.decodeMs).toBeLessThanOrEqual(1000);
      expect(repeat.firstFrameMs).toBeLessThanOrEqual(1000);
      expect(repeat.fullOpacityMs).toBeLessThanOrEqual(1000);
    }
  });
}
