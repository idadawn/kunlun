import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cleanRoutes } from '../../scripts/vite-routes';

export default defineConfig({
  plugins: [react(), cleanRoutes('admin')],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: { '/api': 'http://127.0.0.1:5188', '/healthz': 'http://127.0.0.1:5188' },
  },
});
