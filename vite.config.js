import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera access from a phone on the local network
// (getUserMedia only works in secure contexts; localhost is exempt but
// http://192.168.x.x is not).
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    https: true,
  },
});
