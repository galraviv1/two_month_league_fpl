import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/bootstrap-static': {
        target: 'https://fantasy.premierleague.com',
        changeOrigin: true,
        rewrite: (path) => '/api/bootstrap-static/',
        secure: false,
      },
      '/api/leagues-classic': {
        target: 'https://fantasy.premierleague.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api'),
        secure: false,
      },
      '/api/entry': {
        target: 'https://fantasy.premierleague.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api'),
        secure: false,
      }
    }
  }
})

