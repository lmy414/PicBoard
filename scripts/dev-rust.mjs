#!/usr/bin/env node
// Rust/Tauri development entry with strict data isolation.
//
// Creates a fresh temporary directory that holds ONLY this run's business data
// and log output. The app is started with `--data-root <dir>` so it can never
// read or write the real Electron user-data directory.
//
// Usage:
//   npm run dev:rust            isolated dev run (Vite + Rust host)
//   npm run dev:rust -- --preferences-export <file>
//                                also seed the two renderer preference keys from
//                                an `npm run export:prefs` output file
//
// The temporary directory is printed on start and intentionally NOT deleted
// automatically; the developer may inspect it and clean it up.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const sessionDir = mkdtempSync(join(tmpdir(), `quick-image-board-rust-dev-${stamp}-`));
const dataRoot = join(sessionDir, "data");
const logDir = join(sessionDir, "logs");
mkdirSync(dataRoot, { recursive: true });
mkdirSync(logDir, { recursive: true });

console.log("[dev:rust] isolation directory:", sessionDir);
console.log("[dev:rust] business data root :", dataRoot);
console.log("[dev:rust] logs               :", logDir);

// Extra arguments after `--` are passed to the app (e.g. --preferences-export).
const extra = process.argv.slice(2);

// tauri dev argument layout: `tauri dev -- [runnerArgs] -- [appArgs]`.
const appArgs = ["dev", "--", "--", "--data-root", dataRoot, ...extra];
console.log("[dev:rust] tauri", appArgs.join(" "));

const child = spawn(cli, appArgs, {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    // Keep the frontend on the fixed Vite URL the config expects.
    TAURI_DEV_HOST: process.env.TAURI_DEV_HOST ?? "127.0.0.1",
  },
  shell: process.platform === "win32",
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    console.log(`[dev:rust] terminated by ${signal}`);
    process.exit(130);
  }
  console.log(`[dev:rust] exited with code ${code ?? 0}`);
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("[dev:rust] failed to start tauri:", error);
  process.exit(1);
});

// Write a marker so automated checks can find the isolated data root.
writeFileSync(join(sessionDir, "session.json"), JSON.stringify({
  dataRoot,
  logDir,
  startedAt: new Date().toISOString(),
}, null, 2));
