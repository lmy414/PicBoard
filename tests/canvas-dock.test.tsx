// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CanvasDock } from '../renderer/src/ui/CanvasDock';
afterEach(cleanup);
test('the vertical view tools expand on demand and the minimap remains one click away', () => {
  const onZoom = vi.fn(), onToggleSnap = vi.fn(), onLocateAll = vi.fn(), onToggleMinimap = vi.fn();
  render(<CanvasDock tool="select" onToolChange={vi.fn()} onCreate={vi.fn()} onImportImage={vi.fn()} onCreateCanvas={vi.fn()} historyOpen={false} onToggleHistory={vi.fn()} snapToGrid={false} onToggleSnap={onToggleSnap} zoom={0.64} onZoom={onZoom} onLocateAll={onLocateAll} minimapVisible onToggleMinimap={onToggleMinimap} showViewControls disabled={false} />);
  expect(screen.getByRole('toolbar', { name: '画布视图' }).getAttribute('aria-orientation')).toBe('vertical');
  const minimap = screen.getByRole('button', { name: '小地图' });
  expect(minimap.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(minimap);
  expect(onToggleMinimap).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '展开视图工具' }).textContent).toContain('64%');
  expect(screen.queryByRole('button', { name: '网格对齐' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '展开视图工具' }));
  fireEvent.click(screen.getByRole('button', { name: '缩小', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '网格对齐' }));
  fireEvent.click(screen.getByRole('button', { name: '定位全部节点' }));
  expect(onZoom.mock.calls).toEqual([[-0.1], [0.1]]); expect(onToggleSnap).toHaveBeenCalledOnce(); expect(onLocateAll).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '收起视图工具' }));
  expect(screen.queryByRole('button', { name: '网格对齐' })).toBeNull();
  expect(screen.getByRole('button', { name: '新建富文本节点' })).toBeTruthy();
});
