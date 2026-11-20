import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
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
