import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
input: {
  background: resolve(__dirname, 'src/background.ts'),
  'content-script': resolve(__dirname, 'src/content-script.ts'),
  popup: resolve(__dirname, 'src/popup.ts'),
},
      output: {
        entryFileNames: '[name].js',
      },
    },
    cssCodeSplit: false,
    sourcemap: false,
    minify: false,
    target: 'chrome105',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
