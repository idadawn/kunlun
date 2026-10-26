import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cleanRoutes } from '../../scripts/vite-routes';

const api = process.env.KUNLUN_API_PROXY ?? 'http://127.0.0.1:5188';

export default defineConfig({
  plugins: [react(), cleanRoutes(['member', 'staff'])],
  // Workspace packages import React from source; pre-bundle it once so the first dev load never mixes two copies.
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { include: ['react', 'react/jsx-dev-runtime', 'react-dom/client', 'react-router-dom'] },
  // Distinct asset folders let both apps share one host without clashing with page routes such as /admin/assets.
  build: { assetsDir: 'static/h5' },
  server: {
    port: 5174,
    host: '0.0.0.0',
    proxy: { '/api': api, '/healthz': api },
  },
});
