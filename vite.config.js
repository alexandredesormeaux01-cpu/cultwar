import { defineConfig } from 'vite';

export default defineConfig({
  // Chemins relatifs requis pour Capacitor (chargement depuis le WebView)
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  server: {
    host: true,
  },
});
