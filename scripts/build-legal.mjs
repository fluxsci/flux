#!/usr/bin/env node
// The notices that ship inside the packaged app.
//
// Most of the licences Flux builds on (MIT, BSD, ISC, Apache) ask that their copyright and
// permission notice travel with every copy. The bundlers strip licence comments
// (legalComments: "none", and Vite's minifier), and until 0.4.1 the installers carried no
// notice at all, not even Flux's own LICENSE. This script writes the three files that
// electron-builder copies to <resources>/legal/ (electron-builder.yml, extraResources):
//
//   LICENSE                    Flux's own licence
//   THIRD_PARTY_NOTICES.md     the readable list: what is used, whose it is, what to cite
//   THIRD_PARTY_LICENSES.txt   the licence texts: resources/legal/*.txt (work that npm does
//                              not deliver), then every npm package that can be in the app
//
// Which npm packages: everything the lockfile marks as a runtime dependency (not "dev"), plus
// the few devDependencies whose code is compiled in (EXTRA_ROOTS) and what they depend on.
// That is a superset of what the bundles contain, which is the safe direction. A package that
// is not installed (another platform's native binary) is skipped.
//
//   node scripts/build-legal.mjs [--out <dir>]      default: build/legal
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// devDependencies whose code ends up in the app: Svelte's runtime is compiled into the
// renderer, tslib is shipped for pdf-lib (electron-builder.yml).
export const EXTRA_ROOTS = ['svelte', 'tslib'];

const LICENCE_FILE = /^(licen[sc]e|copying|notice|copyright|unlicense)([.-].*)?$/i;
const RULE = '='.repeat(78);

/** Every lockfile entry that can be in the packaged app: [lockKey, entry] pairs. */
export function runtimePackages(lock, extraRoots = EXTRA_ROOTS) {
  const packages = lock.packages ?? {};
  const keep = new Set();
  for (const [key, entry] of Object.entries(packages)) {
    if (key && !entry.dev && !entry.link) keep.add(key);
  }
  // Node's resolution, on lockfile keys: the nearest node_modules above `from` that has `name`.
  const resolve = (from, name) => {
    let dir = from;
    for (;;) {
      const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
      if (packages[key]) return key;
      if (!dir) return null;
      const cut = dir.lastIndexOf('/node_modules/');
      dir = cut < 0 ? '' : dir.slice(0, cut);
    }
  };
  const queue = extraRoots.map((name) => resolve('', name)).filter(Boolean);
  while (queue.length) {
    const key = queue.pop();
    if (keep.has(key)) continue;
    keep.add(key);
    const entry = packages[key];
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const dep = resolve(key, name);
      if (dep && !keep.has(dep)) queue.push(dep);
    }
  }
  return [...keep].sort().map((key) => [key, packages[key]]);
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return (repo || pkg.homepage || '').replace(/^git\+/, '').replace(/\.git$/, '');
}

function authorOf(pkg) {
  const a = pkg.author;
  if (!a) return '';
  return typeof a === 'string' ? a : [a.name, a.email ? `<${a.email}>` : ''].filter(Boolean).join(' ');
}

/** One package's section, or null when the package is not installed here. */
async function packageSection(key) {
  const dir = path.join(root, key);
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
  const names = (await readdir(dir)).filter((name) => LICENCE_FILE.test(name)).sort();
  const texts = [];
  for (const name of names) {
    const text = (await readFile(path.join(dir, name), 'utf8')).replace(/\r\n/g, '\n').trim();
    if (text) texts.push(names.length > 1 ? `[${name}]\n\n${text}` : text);
  }
  const licence = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'see the package';
  const head = [`${pkg.name} ${pkg.version}`, `Licence: ${licence}`];
  if (authorOf(pkg)) head.push(`Author: ${authorOf(pkg)}`);
  if (repositoryOf(pkg)) head.push(`Source: ${repositoryOf(pkg)}`);
  const body = texts.length
    ? texts.join('\n\n')
    : `The package carries no licence file. It declares the licence "${licence}"; the text is at its source.`;
  return { name: pkg.name, version: pkg.version, licence, hasText: texts.length > 0, text: `${head.join('\n')}\n\n${body}` };
}

export async function buildLegal(outDir = path.join(root, 'build', 'legal')) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  await mkdir(outDir, { recursive: true });

  const extraDir = path.join(root, 'resources', 'legal');
  const extras = (await readdir(extraDir)).filter((name) => name.endsWith('.txt')).sort();
  const parts = [
    `Third-party licences for Flux ${pkg.version}`,
    [
      'Flux is released under the MIT licence (the file LICENSE beside this one). It is built on',
      'the work listed here, which keeps its own licences. THIRD_PARTY_NOTICES.md, also beside',
      'this file, is the readable list: what each piece is used for, whose it is, and the papers',
      'to cite. This file holds the licence texts.',
      '',
      'Electron and Chromium carry their own notices: LICENSE.electron.txt and',
      'LICENSES.chromium.html, in the application folder (on macOS, in the app\'s Resources).',
      'FFmpeg, which exports slide video as a separate program, carries its own beside the',
      'executable (video-encoder/).',
      '',
      'Part 1 is work that Flux copies, ports or ships as data. Part 2 is the npm packages',
      'compiled into the app, in name order.',
    ].join('\n'),
    `${RULE}\nPart 1\n${RULE}`,
  ];
  for (const name of extras) {
    parts.push((await readFile(path.join(extraDir, name), 'utf8')).replace(/\r\n/g, '\n').trim());
    parts.push(RULE);
  }
  parts.push(`Part 2: npm packages\n${RULE}`);

  const seen = new Set();
  const included = [];
  for (const [key] of runtimePackages(lock)) {
    const section = await packageSection(key);
    if (!section) continue;
    const id = `${section.name}@${section.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    included.push(section);
  }
  included.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const section of included) parts.push(section.text, RULE);

  const file = path.join(outDir, 'THIRD_PARTY_LICENSES.txt');
  await writeFile(file, `${parts.join('\n\n')}\n`);
  await copyFile(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'));
  await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(outDir, 'THIRD_PARTY_NOTICES.md'));
  return {
    outDir, file, extras,
    packages: included.map(({ name, version, licence, hasText }) => ({ name, version, licence, hasText })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const result = await buildLegal(at > 0 ? path.resolve(process.argv[at + 1]) : undefined);
  const bare = result.packages.filter((p) => !p.hasText);
  console.log(`legal: ${result.packages.length} npm packages and ${result.extras.length} other notices → ${path.relative(root, result.outDir) || result.outDir}`);
  if (bare.length) console.log(`legal: no licence file in ${bare.map((p) => `${p.name} (${p.licence})`).join(', ')}`);
}
