import { defineConfig } from 'vite';

export default defineConfig({
  // three.js (3D pages) is its own lazily loaded chunk.
  build: { chunkSizeWarningLimit: 700 },
  server: {
    // Keep the browser's Host header so the server's same-origin check matches the page origin.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/mcp': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
});
