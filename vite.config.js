import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera access from a phone on the local network
// (getUserMedia only works in secure contexts; localhost is exempt but
// http://192.168.x.x is not).
// GitHub Pages redirects /schedule to /schedule/; the dev server would
// serve the start page there instead, so redirect the same way.
const dirSlash = (dirs) => {
  const redirect = (req, res, next) => {
    const [path, query] = req.url.split(/\?(.*)/s);
    if (!dirs.includes(path)) return next();
    res.statusCode = 301;
    res.setHeader('Location', `${path}/${query ? `?${query}` : ''}`);
    res.end();
  };
  return {
    name: 'dir-slash',
    configureServer: (server) => { server.middlewares.use(redirect); },
    configurePreviewServer: (server) => { server.middlewares.use(redirect); },
  };
};

export default defineConfig({
  // Relative base: the built dist/ works from any path on any static host
  // (GitHub Pages subpaths, file servers, etc.) with no configuration.
  base: './',
  plugins: [basicSsl(), dirSlash(['/schedule'])],
  build: {
    rollupOptions: {
      // Three pages: the phone app, the big-screen dance floor, DJ booking.
      input: { main: 'index.html', floor: 'floor.html', schedule: 'schedule/index.html' },
    },
  },
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
