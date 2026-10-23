import { build } from 'esbuild';

const outfile = process.argv[2] || 'android/prebuilt/app.bundle.js';
await build({
  entryPoints: ['web/js/app.js'],
  bundle: true,
  format: 'iife',
  target: ['es2015'],
  platform: 'browser',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info',
  outfile,
});
console.log('bundled ->', outfile);
