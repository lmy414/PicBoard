import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string, scheme: string) => `${scheme}://${path}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createTauriAdapter } from '../renderer/src/platform/tauri-adapter';
import type { AppState } from '../shared/image-board';

const state = { activeCanvasId: 'root', canvases: [], categories: [], contents: {}, edges: [] } as unknown as AppState;

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(state as never);
});

test('every renderer command maps to the contract wire name and argument keys', async () => {
  const api = createTauriAdapter();
  vi.mocked(invoke).mockResolvedValue({ state, placed: true } as never);
  const pasted = await api.pasteClipboard('root');
  expect(invoke).toHaveBeenLastCalledWith('paste_clipboard', { canvasId: 'root', viewport: undefined });
  expect(pasted.placed).toBe(true);

  await api.placeContent('content-1', 'root', { x: 10, y: 20 });
  expect(invoke).toHaveBeenLastCalledWith('place_content', { contentId: 'content-1', canvasId: 'root', center: { x: 10, y: 20 } });

  await api.groupNodesIntoCanvas(['n1', 'n2']);
  expect(invoke).toHaveBeenLastCalledWith('group_nodes_into_canvas', { nodeIds: ['n1', 'n2'] });

  await api.moveNodesToCanvas(['n1'], 'child', { x: 5, y: 6 });
  expect(invoke).toHaveBeenLastCalledWith('move_nodes_to_canvas', { nodeIds: ['n1'], targetCanvasId: 'child', origin: { x: 5, y: 6 } });

  await api.createEdge('a', 'b');
  expect(invoke).toHaveBeenLastCalledWith('create_edge', { fromNodeId: 'a', toNodeId: 'b' });

  await api.deleteEdges(['e1']);
  expect(invoke).toHaveBeenLastCalledWith('delete_edges', { edgeIds: ['e1'] });

  await api.removeNodes(['n1']);
  expect(invoke).toHaveBeenLastCalledWith('remove_nodes', { nodeIds: ['n1'] });

  await api.moveNodes([{ nodeId: 'n1', x: 3, y: 4 }, { nodeId: 'n2', x: 8, y: 9 }]);
  expect(invoke).toHaveBeenLastCalledWith('move_nodes', { moves: [{ nodeId: 'n1', x: 3, y: 4 }, { nodeId: 'n2', x: 8, y: 9 }] });

  await api.getContentBody('content-1');
  expect(invoke).toHaveBeenLastCalledWith('get_content_body', { contentId: 'content-1' });

  await api.updateTextContent('content-1', { text: 'x', html: '<p>x</p>' });
  expect(invoke).toHaveBeenLastCalledWith('update_text_content', { contentId: 'content-1', body: { text: 'x', html: '<p>x</p>' } });

  const image = { name: 'inline.png', data: new Uint8Array([1, 2, 3]) };
  const asset = { assetId: 'a1', mime: 'image/png', width: 64, height: 64, byteSize: 3 };
  vi.mocked(invoke).mockResolvedValue(asset as never);
  await expect(api.addContentAsset('content-1', image)).resolves.toEqual(asset);
  expect(invoke).toHaveBeenLastCalledWith('add_content_asset', { contentId: 'content-1', image });

  await api.updateLinkContent('content-1', 'https://example.com');
  expect(invoke).toHaveBeenLastCalledWith('update_link_content', { contentId: 'content-1', url: 'https://example.com' });

  await api.renameImage('content-1', 'new.png');
  expect(invoke).toHaveBeenLastCalledWith('rename_image', { contentId: 'content-1', name: 'new.png' });

  await api.deleteContents(['c1']);
  expect(invoke).toHaveBeenLastCalledWith('delete_contents', { contentIds: ['c1'] });

  await api.classifyContents(['c1'], null);
  expect(invoke).toHaveBeenLastCalledWith('classify_contents', { contentIds: ['c1'], categoryId: null });

  await api.openExternalUrl('https://example.com');
  expect(invoke).toHaveBeenLastCalledWith('open_external_url', { url: 'https://example.com' });

  await api.listPlugins();
  expect(invoke).toHaveBeenLastCalledWith('list_plugins', undefined);

  await api.setDesktopSettings({ captureEnabled: false });
  expect(invoke).toHaveBeenLastCalledWith('set_desktop_settings', { patch: { captureEnabled: false } });

  await api.setCanvasViewport('root', { x: 1, y: 2, zoom: 1.2 });
  expect(invoke).toHaveBeenLastCalledWith('set_canvas_viewport', { canvasId: 'root', viewport: { x: 1, y: 2, zoom: 1.2 } });

  await api.minimizeWindow();
  expect(invoke).toHaveBeenLastCalledWith('minimize_window', undefined);
  await api.quitApp();
  expect(invoke).toHaveBeenLastCalledWith('quit_app', undefined);
  await api.hideTrayPanel();
  expect(invoke).toHaveBeenLastCalledWith('hide_tray_panel', undefined);
  await api.showMainWindow({ view: 'library', contentId: 'c1' });
  expect(invoke).toHaveBeenLastCalledWith('show_main_window', { navigate: { view: 'library', contentId: 'c1' } });
  await api.showMainWindow();
  expect(invoke).toHaveBeenLastCalledWith('show_main_window', { navigate: null });
});

test('copyContents resolves the copied count and imageUrl uses the picboard protocol', async () => {
  vi.mocked(invoke).mockResolvedValue({ copied: 2 } as never);
  const api = createTauriAdapter();
  await expect(api.copyContents(['a', 'b'])).resolves.toEqual({ copied: 2 });
  expect(api.imageUrl('content-1', 'thumb')).toBe('picboard://thumb/content-1');
  expect(api.imageUrl('content-1', 'full')).toBe('picboard://full/content-1');
  expect(api.assetUrl('content-1', 'a1', 'thumb')).toBe('picboard://asset-thumb/content-1/a1');
  expect(api.assetUrl('content-1', 'a1', 'full')).toBe('picboard://asset/content-1/a1');
});

test('image editing and file opening use the typed native command arguments', async () => {
  const api = createTauriAdapter();
  const image = { name: '编辑.png', data: new Uint8Array([137, 80, 78, 71]) };
  await api.readImage('image-1');
  expect(invoke).toHaveBeenLastCalledWith('read_image', { contentId: 'image-1' });
  await api.saveImageCopy(image);
  expect(invoke).toHaveBeenLastCalledWith('save_image_copy', { image });
  await api.exportImage(image);
  expect(invoke).toHaveBeenLastCalledWith('export_image', { image });
  await api.openImageFile();
  expect(invoke).toHaveBeenLastCalledWith('open_image_file', undefined);
  await api.takePendingImage();
  expect(invoke).toHaveBeenLastCalledWith('take_pending_image', undefined);
  await api.getImageAssociation();
  expect(invoke).toHaveBeenLastCalledWith('get_image_association', undefined);
  await api.configureImageAssociation();
  expect(invoke).toHaveBeenLastCalledWith('configure_image_association', undefined);
});

test('host failures become Error instances with the host message', async () => {
  vi.mocked(invoke).mockRejectedValue('画布不存在');
  const api = createTauriAdapter();
  await expect(api.removeNodes(['n1'])).rejects.toThrow('画布不存在');
});

test('state pushes subscribe to the state-changed event and unsubscribe synchronously', async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten as never);
  const adapter = createTauriAdapter();
  const listener = vi.fn();
  const unsubscribe = adapter.onStateChanged(listener);
  await vi.waitFor(() => expect(listen).toHaveBeenCalledWith('state-changed', expect.any(Function)));
  const stateChangedCall = vi.mocked(listen).mock.calls.find(([name]) => name === 'state-changed')!;
  const handler = stateChangedCall[1] as unknown as (event: { payload: AppState }) => void;
  handler({ payload: state });
  expect(listener).toHaveBeenCalledWith(state);
  unsubscribe();
  expect(unlisten).toHaveBeenCalled();
});

test('tray navigation requests subscribe to main:navigate', async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten as never);
  const adapter = createTauriAdapter();
  const listener = vi.fn();
  const unsubscribe = adapter.onNavigate(listener);
  await vi.waitFor(() => expect(listen).toHaveBeenCalledWith('main:navigate', expect.any(Function)));
  const navigateCall = vi.mocked(listen).mock.calls.find(([name]) => name === 'main:navigate')!;
  const handler = navigateCall[1] as unknown as (event: { payload: { view: 'library' } }) => void;
  handler({ payload: { view: 'library' } });
  expect(listener).toHaveBeenCalledWith({ view: 'library' });
  unsubscribe();
  expect(unlisten).toHaveBeenCalled();
});
