#!/usr/bin/env node
// Rust/Tauri development entry with strict data isolation.
//
// The `tauri dev` child is launched through the @tauri-apps/cli JS API (native
// binding) — no shell, so Windows paths with spaces/special characters are
// passed as exact argv entries and never need shell quoting.
//
// Usage:
//   npm run dev:rust                     isolated dev run (Vite + Rust host)
//   npm run dev:rust -- --preferences-export <file>
//                                        also seed the two renderer preference keys
//                                        from an `npm run export:prefs` output file
//   npm run dev:rust -- --data-root <dir>
//                                        reuse an EXISTING data root instead of a
//                                        fresh temp dir (caller is responsible for
//                                        isolation; never points at the real
//                                        Electron user data by default)
//
// Default isolation: a fresh temporary directory holds ONLY this run's business
// data and log output, and `--data-root <dir>` is always passed explicitly so
// the app can never read/write the real Electron user-data directory. The
// temporary directory is printed on start and intentionally NOT deleted
// automatically; the developer may inspect it and clean it up.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

// ---- argument parsing ------------------------------------------------------
// Arguments after the script name are either our `--data-root` option or app
// arguments forwarded after the second `--`.
const forwarded = [];
let explicitDataRoot = null;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--data-root") {
    const value = process.argv[i + 1];
    if (!value) {
      console.error("[dev:rust] --data-root requires a directory path");
      process.exit(1);
    }
    explicitDataRoot = value;
    i += 1;
  } else if (arg.startsWith("--data-root=")) {
    explicitDataRoot = arg.slice("--data-root=".length);
  } else {
    forwarded.push(arg);
  }
}

let dataRoot;
let sessionDir = null;
let logDir = null;
if (explicitDataRoot) {
  dataRoot = isAbsolute(explicitDataRoot)
    ? explicitDataRoot
    : resolve(process.cwd(), explicitDataRoot);
  console.log("[dev:rust] using existing data root:", dataRoot);
  console.log("[dev:rust] (isolation is the caller's responsibility for this run)");
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  sessionDir = mkdtempSync(join(tmpdir(), `quick-image-board-rust-dev-${stamp}-`));
  dataRoot = join(sessionDir, "data");
  logDir = join(sessionDir, "logs");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  console.log("[dev:rust] isolation directory:", sessionDir);
  console.log("[dev:rust] business data root :", dataRoot);
  console.log("[dev:rust] logs               :", logDir);
  // Write a marker so automated checks can find the isolated data root.
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({ dataRoot, logDir, startedAt: new Date().toISOString() }, null, 2),
  );
}

// ---- tauri dev invocation ---------------------------------------------------
// `tauri dev -- [runnerArgs] -- [appArgs]`; each path is a separate argv entry,
// so no shell quoting/escaping is needed.
const appArgs = ["dev", "--", "--", "--data-root", dataRoot, ...forwarded];
console.log("[dev:rust] tauri", appArgs.join(" "));

let run;
try {
  ({ run } = await import("@tauri-apps/cli"));
} catch (error) {
  console.error("[dev:rust] failed to load @tauri-apps/cli:", error);
  process.exit(1);
}

try {
  await run(appArgs, "tauri");
  console.log("[dev:rust] exited normally");
  process.exit(0);
} catch (error) {
  const code = error?.exitCode ?? error?.code ?? 1;
  console.log(`[dev:rust] exited with code ${code}`);
  if (error?.message && !String(error.message).includes(String(code))) {
    console.error(String(error.message));
  }
  process.exit(Number.isInteger(code) ? code : 1);
}
