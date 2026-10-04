import { defineConfig } from 'vite';

// `base` is set so the build works on GitHub Pages under /world-grab/.
// In dev it is ignored for the root path.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/world-grab/' : '/',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
    assetsInlineLimit: 2048,
  },
}));
