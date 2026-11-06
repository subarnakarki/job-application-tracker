import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The production Content-Security-Policy, read from vercel.json so there is one source of truth.
 * `vite preview` (the production build, used by the e2e CSP check) sends it, so a blocked font,
 * style or script shows up in tests, not only on Vercel. `upgrade-insecure-requests` is left out:
 * it restricts nothing and would only try to turn the local http preview into https.
 */
function productionCsp(): string {
  const config = JSON.parse(
    readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'),
  ) as { headers: { headers: { key: string; value: string }[] }[] };
  const value = config.headers
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === 'Content-Security-Policy')?.value;
  if (!value) throw new Error('vercel.json has no Content-Security-Policy header');
  return value
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive && directive !== 'upgrade-insecure-requests')
    .join('; ');
}

// The API is proxied so the browser sees a single origin in development,
// matching production (same host for the SPA and /api).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // The service worker is its own entry, served at /sw.js (a worker's scope is its path).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        sw: fileURLToPath(new URL('./src/sw/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  preview: {
    headers: { 'Content-Security-Policy': productionCsp() },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
