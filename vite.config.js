import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Basis-Pfad für GitHub Pages: https://fireheadffm.github.io/BoozeYard/
export default defineConfig({
  base: '/BoozeYard/',
  plugins: [react()],
})
