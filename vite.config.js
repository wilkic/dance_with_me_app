import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera access from a phone on the local network
// (getUserMedia only works in secure contexts; localhost is exempt but
// http://192.168.x.x is not).
export default defineConfig({
  // Relative base: the built dist/ works from any path on any static host
  // (GitHub Pages subpaths, file servers, etc.) with no configuration.
  base: './',
  plugins: [basicSsl()],
  server: {
    https: true,
    proxy: {
      // Dance-analysis server: the app opens wss://<host>/ws when started
      // with ?server=1, riding the already-accepted dev cert. Run it with
      // `npm start` in server/.
      '/ws': { target: 'ws://localhost:8901', ws: true },
    },
  },
});
