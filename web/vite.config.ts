// defineConfig from vitest/config, not vite: it is the one that also
// accepts the `test` block below.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base: './' is REQUIRED and is the one build setting that must not be
// changed.
//
// The bundle does not know where it will be mounted. Its id comes from
// the file name the operator gives the zip, so the same artifact may be
// served at /site/cryoem/ or /site/cryoem-next/. A baked-in absolute
// base would break every asset URL the moment somebody renames the file
// to stage a candidate. Relative URLs plus the <base href> the server
// injects resolve correctly wherever the app lands.
//
// For client-side routing, read window.__HTCONDOR_APP__.base -- see
// src/lib/htcondor.ts.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    // Dev only. In production the app is served by the same origin as
    // the API, so none of this applies and there is no CORS to think
    // about. Here we forward the API and auth paths to a real server so
    // the session cookie works in development too.
    proxy: Object.fromEntries(
      ['/api', '/login', '/logout', '/idp', '/openapi.json'].map((path) => [
        path,
        {
          target: process.env.VITE_API_TARGET ?? 'https://localhost:8443',
          changeOrigin: true,
          // Demo mode serves HTTPS with a CA it generated at startup,
          // which nothing trusts. Refusing it here would just block
          // development against the demo server.
          secure: false,
        },
      ]),
    ),
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
