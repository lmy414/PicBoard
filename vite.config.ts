import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Rust build output changes constantly under tauri dev; watching the
      // dll/executables on Windows triggers EBUSY and kills Vite.
      ignored: ["**/src-tauri/target/**", "**/dist/**"],
    },
  },
});
