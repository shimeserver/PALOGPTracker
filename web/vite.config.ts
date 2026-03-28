import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',  // Electronのfile://プロトコルで動作するよう相対パスに
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
