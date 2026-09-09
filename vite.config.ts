import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export default defineConfig({
  base: '/client/',
  publicDir: false,
  plugins: [
    {
      name: 'public-world-runtime',
      generateBundle(_options, bundle) {
        for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'])
          this.emitFile({
            type: 'asset',
            fileName: `brand/${file}`,
            source: readFileSync(resolve('assets/site', file)),
          });
        for (const file of ['three.txt', 'zod.txt', 'bricolage-grotesque.txt'])
          this.emitFile({
            type: 'asset',
            fileName: `licenses/${file}`,
            source: readFileSync(resolve('licenses', file)),
          });
        const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
        const forbidden =
          /(?:\/packages\/core\/(?:config|registry|http|public-fetch|rate-limit)\.|\/apps\/|\/packages\/room\/server\.|\/node_modules\/(?:fastify|ws|dotenv)\/|^node:)/;
        for (const chunk of chunks)
          for (const id of Object.keys(chunk.modules))
            if (forbidden.test(id.replaceAll('\\', '/')))
              throw new Error(`Server module in browser build: ${id}`);
        const visited = new Set<string>();
        const checkSdk = (file: string) => {
          if (visited.has(file)) return;
          visited.add(file);
          const chunk = chunks.find((item) => item.fileName === file);
          if (!chunk) throw new Error(`Missing SDK chunk: ${file}`);
          for (const id of Object.keys(chunk.modules))
            if (/\/(?:three|packages\/three)\//.test(id.replaceAll('\\', '/')))
              throw new Error('The SDK must not import a renderer.');
          chunk.imports.forEach(checkSdk);
        };
        checkSdk('runtime/sdk.js');
      },
    },
  ],
  build: {
    target: 'es2022',
    outDir: 'dist/client',
    cssCodeSplit: false,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        'runtime/sdk': resolve('packages/sdk/index.ts'),
        'runtime/three': resolve('packages/three/browser.ts'),
        'runtime/character': resolve('packages/character/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? 'runtime/runtime.css'
            : 'assets/[name]-[hash][extname]',
      },
    },
    chunkSizeWarningLimit: 650,
  },
});
