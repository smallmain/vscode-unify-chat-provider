import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'media/usage-detail',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1400,
    assetsDir: '.',
    rollupOptions: {
      input: 'webviews/usage-detail/src/main.ts',
      output: {
        entryFileNames: 'usage-detail.js',
        chunkFileNames: 'usage-detail-[hash].js',
        assetFileNames: (assetInfo) => assetInfo.name?.endsWith('.css')
          ? 'usage-detail.css'
          : 'usage-detail-[hash][extname]',
      },
    },
  },
});
