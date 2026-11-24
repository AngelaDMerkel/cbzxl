import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await mkdir('dist');
await build({entryPoints:['web/app.ts','web/app.css'],outdir:'dist',bundle:true,minify:true,format:'esm',target:['es2022'],sourcemap:false,logLevel:'info'});
await copyFile('web/index.html','dist/index.html');
await copyFile('web/favicon.svg','dist/favicon.svg');
