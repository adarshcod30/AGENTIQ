import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/**
 * Tailwind v4 is CSS-first: it is a VITE PLUGIN, and there is no
 * tailwind.config.js and no postcss.config.js. Design tokens live in
 * src/index.css under @theme. See docs/02_TRD.md §3.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    port: 5173,
    // The API base URL is read from VITE_API_URL at runtime (services/api.ts).
    // Hardcoding localhost here would make the app impossible to deploy.
  },
});
