import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    // Git worktrees under .worktrees carry their own stale node_modules and
    // test copies; vitest's path-filter matching would otherwise run them.
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        orbDemo: resolve(process.cwd(), "orb-demo.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Native build artifacts and isolated app data change while Tauri is
      // running. Windows may lock their temporary files, so Vite must never
      // attach file watchers to either tree.
      ignored: [
        "**/src-tauri/target/**",
        "**/dist/**",
        "**/.tmp-gui-data*/**",
        "**/.quick-image-board-dev-data/**",
      ],
    },
  },
});
