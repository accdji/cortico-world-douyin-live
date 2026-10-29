import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/webui/client.ts'],
  bundle: true,
  outfile: 'dist/webui.js',
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  logLevel: 'info',
});

console.log('wrote dist/webui.js');
