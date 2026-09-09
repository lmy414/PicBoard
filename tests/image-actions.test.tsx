// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuickActions } from '../renderer/src/ui/ImageActions';
afterEach(cleanup);
const state: any = { images: { one: { id: 'one', fileName: 'sample.png', status: 'pending' } }, categories: [] };
function mount() {
  const source = document.createElement('div'); source.className = 'image-card'; document.body.append(source);
  let x = 40;
  source.getBoundingClientRect = () => ({ left: x, right: x + 100, top: 50, bottom: 150, width: 100, height: 100 } as DOMRect);
  const onClose = vi.fn();
  const view = render(<div className="app-shell"><QuickActions state={state} selectedIds={['one']} source={source} anchor={null} showRemove onClose={onClose} onUpdate={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} onCopy={vi.fn()} onPrompt={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} /></div>);
  view.container.querySelector('.app-shell')!.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } as DOMRect);
  return { onClose, move: (next: number) => { x = next; }, source };
}
test('expands inside the image card without a floating dialog', async () => {
  const { source } = mount();
  const region = screen.getByRole('region', { name: '图片操作' });
  expect(source.contains(region)).toBe(true);
  expect(source.classList.contains('actions-expanded')).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(region.style.left).toBe('');
  cleanup();
  expect(source.classList.contains('actions-expanded')).toBe(false);
  source.remove();
});
test('rename stays inline, preserves errors, and Escape returns to actions', async () => {
  (window as any).imageBoard = { renameImage: vi.fn().mockRejectedValue(new Error('名称冲突')) };
  const { source, onClose } = mount();
  fireEvent.click(screen.getByText('重命名'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new.png' } });
  fireEvent.click(screen.getByText('保存'));
  await screen.findByText('名称冲突');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('new.png');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  source.remove();
});

test('classification replaces the action row instead of opening another panel', () => {
  const { source } = mount();
  expect(screen.queryByText('＋ 新分类')).toBeNull();
  fireEvent.click(screen.getByText('分类 ▾'));
  expect(screen.getByText('＋ 新分类')).toBeTruthy();
  expect(screen.queryByText('复制')).toBeNull();
  expect(screen.getAllByRole('region')).toHaveLength(1);
  fireEvent.click(screen.getByText('‹ 返回'));
  expect(screen.getByText('复制')).toBeTruthy();
  cleanup(); source.remove();
});
