import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [visualizer()],
  build: {
    chunkSizeWarningLimit: 1000, // Increased limit to suppress warnings for large chunks
  },
});
