import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served from https://<user>.github.io/au-savings-compare/ on GitHub Pages; override with BASE_PATH.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/au-savings-compare/',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
});
