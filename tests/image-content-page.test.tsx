// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ContentRecord } from '../shared/image-board';
import { ImageContentPage } from '../renderer/src/pages/ImageContentPage';

const pageStyles = readFileSync('renderer/src/pages/content-page.css', 'utf8');

const content: ContentRecord = {
  id: 'clipboard-image',
  kind: 'image',
  preview: '剪贴板图片.png',
  textLength: 0,
  url: null,
  image: { fileName: '剪贴板图片.png', relativePath: 'content/clipboard-image/image.png', width: 1497, height: 918, byteSize: 180353 },
  coverAsset: null,
  categoryId: null,
  source: 'clipboard',
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
  lastUsedAt: '2026-11-03T00:00:00.000Z',
};

let style: HTMLStyleElement;

beforeEach(() => {
  window.imageBoard = {
    imageUrl: (id: string, variant: string) => `picboard://${variant}/${id}`,
  } as unknown as typeof window.imageBoard;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON() {},
  });
  style = document.createElement('style');
  style.textContent = pageStyles;
  document.head.append(style);
});

afterEach(() => {
  cleanup();
  style.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('a clipboard image becomes visible after loading with the actual viewer styles', () => {
  const onError = vi.fn();
  render(<ImageContentPage content={content} onError={onError} />);
  const image = screen.getByAltText<HTMLImageElement>('剪贴板图片.png');
  expect(image.getAttribute('src')).toBe('picboard://full/clipboard-image');
  expect(getComputedStyle(image).opacity).toBe('0');

  fireEvent.load(image);

  expect(getComputedStyle(image).opacity).toBe('1');
  expect(document.querySelector('.cp-image-stage')?.getAttribute('style')).toContain('scale(');
  expect(document.querySelector('.cp-image-loading.is-done')).toBeTruthy();
  expect(onError).not.toHaveBeenCalled();
});

test('an image without stored dimensions becomes visible using its decoded size', () => {
  render(<ImageContentPage content={{ ...content, image: { ...content.image!, width: 0, height: 0 } }} onError={vi.fn()} />);
  const image = screen.getByAltText<HTMLImageElement>('剪贴板图片.png');
  const stage = document.querySelector<HTMLElement>('.cp-image-stage')!;
  expect(getComputedStyle(stage).visibility).toBe('hidden');
  Object.defineProperties(image, { naturalWidth: { value: 1497 }, naturalHeight: { value: 918 } });

  fireEvent.load(image);

  expect(getComputedStyle(stage).visibility).toBe('visible');
  expect(getComputedStyle(image).opacity).toBe('1');
  expect(stage.style.width).toBe('1497px');
  expect(stage.style.height).toBe('918px');
});

test('an unreadable image shows a failure message and stops the loading indicator', () => {
  const onError = vi.fn();
  render(<ImageContentPage content={content} onError={onError} />);
  const image = screen.getByRole('img', { name: '剪贴板图片.png' });

  fireEvent.error(image);

  expect(screen.getByRole('alert').textContent).toContain('图片载入失败');
  expect(getComputedStyle(image).opacity).toBe('0');
  expect(document.querySelector('.cp-image-loading.is-done')).toBeTruthy();
  expect(onError).toHaveBeenCalledWith('图片载入失败');
});
