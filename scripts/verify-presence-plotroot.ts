import fs from 'node:fs';import path from 'node:path';import {harness} from './lib/harness.mjs';
const h=harness('verify-presence-plotroot');
const files=(dir:string):string[]=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):/\.(ts|svelte)$/.test(e.name)?[path.join(dir,e.name)]:[]);
const unexpected=[];for(const file of files('src')){const lines=fs.readFileSync(file,'utf8').split('\n');for(let i=0;i<lines.length;i++)if(/ctx\.plotRoot\(/.test(lines[i])&&!lines[i].includes('relayout-native-root:')&&!lines[i-1]?.includes('relayout-native-root:'))unexpected.push(`${file}:${i+1}`);}
h.eq(unexpected,[],'geometry readers use variants; pristine root access is explicit');await h.done();
