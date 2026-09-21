#!/usr/bin/env node
// Build the existing Quarto corpus for installed, offline-readable help.
// Staging and validation finish before the previous good site is replaced.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { runProcess } from '../electron/processRunner.cjs';
import { inventory, replacePrepared, recoverPrevious, withAssetInstall } from './lib/runtimeAssets.mjs';

export async function documentationPages(source) {
  const pages = [];
  async function walk(dir, relative = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_site') || entry.name === 'for_agents') continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), next);
      else if (entry.name.endsWith('.qmd')) pages.push(next.replace(/\.qmd$/, '.html'));
    }
  }
  await walk(source);
  if (!pages.includes('index.html')) throw new Error('Documentation corpus has no index.qmd');
  return pages.sort();
}

export async function validateDocumentation(directory, pages) {
  const files = await inventory(directory, new Set(['.flux-docs.json']));
  for (const page of pages) {
    if (!files[page]) throw new Error(`Rendered documentation page missing: ${page}`);
    const html = await fs.readFile(path.join(directory, page), 'utf8');
    const { document } = parseHTML(html);
    if (!document.querySelector('title')?.textContent || !document.querySelector('body')?.textContent.trim())
      throw new Error(`Rendered documentation page is empty: ${page}`);
    for (const node of document.querySelectorAll('[src],link[href],a[href]')) {
      const raw = node.getAttribute('src') ?? node.getAttribute('href');
      await requireLocalResource(page, raw);
    }
  }
  for (const name of Object.keys(files)) {
    if (/\.css$/i.test(name)) {
      const css = await fs.readFile(path.join(directory, name), 'utf8');
      for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) await requireLocalResource(name, match[1]);
    }
    if (/(?:^|\/)for_agents\//.test(name) || /AGENT_ENGINEERING_GUIDE|\.qmd$|\.md$/i.test(name))
      throw new Error(`Contributor/source document leaked into packaged help: ${name}`);
  }
  async function requireLocalResource(from, raw) {
    if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)) return;
    const decoded = decodeURIComponent(raw.split(/[?#]/)[0]);
    if (!decoded) return;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded));
    if (decoded.startsWith('/') || rel.startsWith('../')) throw new Error(`Documentation resource escapes its bundle: ${from} -> ${raw}`);
    const target = rel.endsWith('/') || rel === '.' ? path.posix.join(rel, 'index.html') : rel;
    if (!files[target]) throw new Error(`Documentation resource missing: ${from} -> ${raw}`);
  }
  return files;
}

async function makeFileLinksExplicit(directory, pages) {
  // A website server resolves ../ to index.html; an OS browser opening file:
  // otherwise displays a directory listing. Preserve query/anchor components.
  for (const page of pages) {
    const file = path.join(directory, page), html = await fs.readFile(file, 'utf8');
    const explicit = html.replace(/(\bhref\s*=\s*)(["'])([^"']*)\2/gi, (whole, prefix, quote, href) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return whole;
      const match = /^([^?#]*)(.*)$/.exec(href);
      return match[1].endsWith('/') ? `${prefix}${quote}${match[1]}index.html${match[2]}${quote}` : whole;
    });
    if (explicit !== html) await fs.writeFile(file, explicit);
  }
}

async function bundleFileSearch(directory, pages) {
  const searchFile = path.join(directory, 'site_libs/quarto-search/quarto-search.js');
  const searchSource = await fs.readFile(searchFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (searchSource === null) return; // A corpus may deliberately disable search.
  // Quarto's regular file:// path refuses fetch(search.json). Seed its existing
  // Fuse index instead; the shipped UI, ranking options and HTTP behavior stay
  // the same. Fail clearly if a future Quarto changes this narrow contract.
  if (!/var fuseIndex = undefined;/.test(searchSource) || !/const kFuseIndexOptions =/.test(searchSource))
    throw new Error('Quarto search contract changed; review the offline index adapter before packaging');
  const search = JSON.parse(await fs.readFile(path.join(directory, 'search.json'), 'utf8'));
  if (!Array.isArray(search) || !search.length || search.some(item => typeof item?.href !== 'string' || typeof item?.text !== 'string'))
    throw new Error('Rendered documentation search index is invalid');
  const data = JSON.stringify(search).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await fs.writeFile(path.join(directory, 'site_libs/flux-search-index.js'), `// Preload the bundled Quarto index for OS-browser file URLs.\nif (location.protocol === "file:") { fuseIndex = new window.Fuse(${data}, kFuseIndexOptions); }\n`);
  for (const page of pages) {
    const file = path.join(directory, page), html = await fs.readFile(file, 'utf8');
    const relative = path.posix.relative(path.posix.dirname(page), 'site_libs/flux-search-index.js');
    const tag = /<script\b[^>]*\bsrc=["'][^"']*quarto-search\/quarto-search\.js["'][^>]*>\s*<\/script>/i;
    if (!tag.test(html)) throw new Error(`Quarto search script missing from documentation page: ${page}`);
    await fs.writeFile(file, html.replace(tag, whole => `${whole}\n<script src="${relative}"></script>`));
  }
}

async function renderWithQuarto(source, staging) {
  const executable = process.env.FLUX_QUARTO || 'quarto';
  const version = await runProcess({ executable, argv: ['--version'], cwd: source }, { timeoutMs: 10000 });
  if (version.status !== 'exited' || version.code !== 0)
    throw new Error(`Quarto is required to package documentation (${version.status}): ${version.stderr || version.stdout}`);
  const result = await runProcess({ executable, argv: ['render', '.', '--output-dir', path.basename(staging), '--no-execute'], cwd: source },
    { timeoutMs: 300000, maxOutputBytes: 4 * 1024 * 1024, onOutput: (stream, bytes) => process[stream].write(bytes) });
  if (result.status !== 'exited' || result.code !== 0) throw new Error(`Documentation render failed (${result.status}, exit ${result.code})`);
  return version.stdout.trim();
}

export async function buildDocumentation({ source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs'), render = renderWithQuarto, replace = replacePrepared } = {}) {
  return withAssetInstall(source, 'docs-site', async assertOwned => {
    const target = path.join(source, '_site');
    await recoverPrevious(target);
    const pages = await documentationPages(source);
    const staging = await fs.mkdtemp(path.join(source, '.fetch-docs-site-'));
    try {
      const quartoVersion = await render(source, staging);
      await makeFileLinksExplicit(staging, pages);
      await bundleFileSearch(staging, pages);
      const files = await validateDocumentation(staging, pages);
      await fs.writeFile(path.join(staging, '.flux-docs.json'), JSON.stringify({ version: 1, quartoVersion, pages, files }, null, 2) + '\n');
      await assertOwned();
      await replace(staging, target);
      return { directory: target, pages: pages.length, files: Object.keys(files).length, quartoVersion };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildDocumentation(), null, 2));
}
