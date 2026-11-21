import react from '@vitejs/plugin-react';
import { appendFileSync, mkdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// bench-gba.html posts its results here so runs on other
// devices (an iPhone on the LAN) land in tools/out/bench-results.jsonl.
const benchResults: Plugin = {
  name: 'gba-bench-results',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__bench-result', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        mkdirSync('tools/out', { recursive: true });
        appendFileSync('tools/out/bench-results.jsonl', body.replace(/\n/g, ' ') + '\n');
        console.log(`[gba bench] ${body}`);
        res.end('ok');
      });
    });
  },
};
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    benchResults,
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'audio-worklet.js'],
      manifest: {
        name: 'Lockstep',
        short_name: 'Lockstep',
        description: 'A Game Boy that keeps your Nuzlocke honest.',
        display: 'standalone',
        orientation: 'any',
        background_color: '#d9d3e3',
        theme_color: '#d9d3e3',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
