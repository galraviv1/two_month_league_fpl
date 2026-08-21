import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In dev, proxy the one live endpoint the app uses straight to FPL. All
    // other data comes from the static public/data/standings.json file.
    proxy: {
      '/api/event': {
        target: 'https://fantasy.premierleague.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api'),
        secure: false,
      }
    }
  }
})

