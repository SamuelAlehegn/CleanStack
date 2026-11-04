import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root,
  // Relative asset URLs let the built UI run from any host or subpath,
  // including plain static hosting of web/dist.
  base: './',
  plugins: [react()],
  server: {
    fs: {
      // The UI imports API contracts from ../src/web/contracts.ts.
      allow: [projectRoot],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
