// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImageFileSettings } from '../renderer/src/ui/ImageFileSettings';

afterEach(cleanup);
test('development builds cannot register system image associations', async () => {
  const configure = vi.fn();
  window.imageBoard = { getImageAssociation: vi.fn().mockResolvedValue({available:false,registered:false}), configureImageAssociation:configure } as unknown as typeof window.imageBoard;
  render(<ImageFileSettings />);
  await waitFor(()=>expect(screen.getByRole<HTMLButtonElement>('button',{name:'设为默认图片应用'}).disabled).toBe(true));
  expect(configure).not.toHaveBeenCalled();
});
test('release registration opens system settings only after the user clicks', async () => {
  const configure = vi.fn().mockResolvedValue(undefined);
  window.imageBoard = { getImageAssociation:vi.fn().mockResolvedValue({available:true,registered:false}),configureImageAssociation:configure } as unknown as typeof window.imageBoard;
  render(<ImageFileSettings />);
  const button=screen.getByRole<HTMLButtonElement>('button',{name:'设为默认图片应用'});
  await waitFor(()=>expect(button.disabled).toBe(false));
  expect(configure).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(()=>expect(configure).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole('status')).toBeTruthy();
});
