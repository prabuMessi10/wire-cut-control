import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Vite dev server proxies /api to the Express backend so the browser only
// ever talks to one origin - this keeps the JWT in an httpOnly cookie without
// tripping CORS or SameSite restrictions during local development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});