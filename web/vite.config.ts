import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',  // Electronのfile://プロトコルで動作するよう相対パスに
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // ベンダーを分割してキャッシュ効率と並列ロードを改善（1MB単一チャンク対策）
        manualChunks(id: string) {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase';
          if (id.includes('node_modules/@react-google-maps')) return 'gmaps';
        },
      },
    },
  },
})
