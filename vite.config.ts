import { defineConfig } from 'vite';

// Relative base so the build works from any folder or sub-path (GitHub Pages, Tauri, file hosting).
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
