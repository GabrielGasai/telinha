import { defineConfig } from 'vite'

// Configuração padrão para Tauri: porta fixa e build moderno (WebView2 = Chromium).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'chrome110', minify: 'esbuild', sourcemap: false },
})
