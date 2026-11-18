import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Keep the browser's Host header so the server's same-origin check matches the page origin.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/mcp': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
});
