const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');
const path = require('path');

module.exports = defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'web'),
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true
  }
});