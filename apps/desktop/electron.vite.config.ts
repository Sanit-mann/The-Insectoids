import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Strict content security policy for built pages. The dev server needs inline scripts for hot reload, so it is skipped there.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const cspPlugin: Plugin = {
  name: 'insectoids-csp',
  transformIndexHtml: {
    order: 'post',
    handler: (html, ctx) =>
      ctx.server ? html : html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
  },
};

export default defineConfig({
  main: {
    build: {
      // Workspace packages are TypeScript source: bundle them instead of requiring at runtime.
      externalizeDeps: { exclude: ['@insectoids/shared', '@insectoids/brain', '@insectoids/brain-service', '@insectoids/brain-cli', '@insectoids/harness', '@insectoids/workspace', '@insectoids/reflexes', '@insectoids/embeddings', '@insectoids/codemap'] },
      rolldownOptions: {
        // Two main-side entries: the app's main process and the Brain host utility process.
        input: { index: r('./src/main/index.ts'), 'brain-host': r('./src/brain-host/index.ts') },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preload scripts must be a single CommonJS file.
      externalizeDeps: false,
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: { alias: { '@': r('./src/renderer/src') } },
    plugins: [react(), tailwindcss(), cspPlugin],
  },
});
