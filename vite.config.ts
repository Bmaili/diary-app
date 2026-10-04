import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30000 },
} as any)
