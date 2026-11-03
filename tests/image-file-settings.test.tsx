// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ImageFileSettings } from "../renderer/src/ui/ImageFileSettings";

function host(status = { available: true, registered: false }) {
  const getImageAssociation = vi.fn().mockResolvedValue(status);
  const configureImageAssociation = vi.fn().mockResolvedValue(undefined);
  window.imageBoard = { getImageAssociation, configureImageAssociation } as unknown as typeof window.imageBoard;
  return { getImageAssociation, configureImageAssociation };
}

afterEach(cleanup);

test("development builds cannot register system image associations", async () => {
  const mocks = host({ available: false, registered: false });
  const view = render(<ImageFileSettings />);
  await view.findByText(/开发版不修改系统文件关联/);
  expect(view.getByRole<HTMLButtonElement>("button", { name: "设为默认图片应用" }).disabled).toBe(true);
  expect(mocks.configureImageAssociation).not.toHaveBeenCalled();
});

test("release registration opens system settings only after the user clicks", async () => {
  const mocks = host();
  mocks.getImageAssociation.mockResolvedValueOnce({ available: true, registered: false }).mockResolvedValue({ available: true, registered: true });
  const view = render(<ImageFileSettings />);
  const button = view.getByRole<HTMLButtonElement>("button", { name: "设为默认图片应用" });
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(mocks.configureImageAssociation).not.toHaveBeenCalled();
  fireEvent.click(button);
  await view.findByRole("button", { name: "管理默认图片应用" });
  expect(mocks.configureImageAssociation).toHaveBeenCalledTimes(1);
  expect(mocks.getImageAssociation).toHaveBeenCalledTimes(2);
  expect(view.getByRole("status").textContent).toContain("Windows 默认应用设置");
  expect(view.getByText(/默认关联由 Windows 中的选择决定/)).toBeTruthy();
});

test("an already registered opener remains manageable without claiming Windows defaults", async () => {
  const mocks = host({ available: true, registered: true });
  const view = render(<ImageFileSettings />);
  const button = await view.findByRole("button", { name: "管理默认图片应用" });
  expect(view.getByText(/默认关联由 Windows 中的选择决定/)).toBeTruthy();
  expect(mocks.configureImageAssociation).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(mocks.configureImageAssociation).toHaveBeenCalledTimes(1));
});

test("registration errors keep the action available for a user retry", async () => {
  const mocks = host();
  mocks.configureImageAssociation.mockRejectedValueOnce(new Error("注册失败，请重试"));
  const view = render(<ImageFileSettings />);
  const button = view.getByRole<HTMLButtonElement>("button", { name: "设为默认图片应用" });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  expect((await view.findByRole("alert")).textContent).toBe("注册失败，请重试");
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(mocks.configureImageAssociation).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

test("a failed availability check reports the error and does not register", async () => {
  const mocks = host();
  mocks.getImageAssociation.mockRejectedValueOnce(new Error("无法读取图片关联"));
  const view = render(<ImageFileSettings />);
  expect((await view.findByRole("alert")).textContent).toBe("无法读取图片关联");
  expect(view.getByRole<HTMLButtonElement>("button", { name: "设为默认图片应用" }).disabled).toBe(true);
  expect(mocks.configureImageAssociation).not.toHaveBeenCalled();
});

test("a pending user registration disables repeated clicks", async () => {
  const mocks = host();
  let finish: (() => void) | undefined;
  mocks.configureImageAssociation.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<ImageFileSettings />);
  const button = view.getByRole<HTMLButtonElement>("button", { name: "设为默认图片应用" });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(mocks.configureImageAssociation).toHaveBeenCalledTimes(1);
  finish?.();
  await waitFor(() => expect(button.disabled).toBe(false));
});
