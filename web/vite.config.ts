import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: works at a site root (Cloudflare, Netlify) and under /repo-name/ (GitHub Pages).
  base: "./",
  server: { port: 5173, strictPort: true },
  build: { chunkSizeWarningLimit: 700 },
});
