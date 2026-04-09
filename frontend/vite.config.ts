import { resolve } from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/static/dist/' : '/',
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, '../src/astra/static/dist'),
    emptyOutDir: true,
  },
}))
