import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
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
