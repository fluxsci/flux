import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import * as yaml from 'js-yaml';
import { buildDocumentation, validateDocumentation } from './build-docs.mjs';
import { replacePrepared } from './lib/runtimeAssets.mjs';
import { documentationIndex, openDocumentation } from '../electron/documentation.cjs';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-docs-test-'));
const source = path.join(scratch, 'checkout with spaces Ω', 'docs');
const site = path.join(source, '_site');
let checks = 0;
const ok = (actual, message) => { assert.ok(actual, message); checks++; };
async function write(relative, bytes, root = source) { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
async function render(_source, output) {
  await write('index.html', '<!doctype html><html><head><title>Flux</title><link href="site_libs/style.css" rel="stylesheet"></head><body><h1>Flux help</h1><a href="modes/figure.html">Figure</a><img src="logo.svg"></body></html>', output);
  await write('modes/figure.html', '<!doctype html><html><head><title>Figure</title><link href="../site_libs/style.css" rel="stylesheet"></head><body><h1>Figure help</h1><a href="../">Home</a></body></html>', output);
  await write('site_libs/style.css', '@font-face{font-family:fixture;src:url(font.woff2)}body{color:#123456}', output);
  await write('site_libs/font.woff2', 'fixture-font', output);
  await write('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', output);
  return 'fixture-quarto';
}
try {
  await write('index.qmd', '# Help'); await write('modes/figure.qmd', '# Figure');
  await write('for_agents/private.qmd', '# Excluded');
  await write('_site/index.html', 'previous good bytes');
  const built = await buildDocumentation({ source, render });
  ok(built.pages === 2 && built.files === 5, 'complete rendered page and asset inventory');
  const saved = await fs.readFile(path.join(site, 'index.html'));
  ok((await fs.readFile(path.join(site, 'modes/figure.html'), 'utf8')).includes('href="../index.html"'), 'directory links resolve to an explicit page in an OS file browser');
  const manifest = JSON.parse(await fs.readFile(path.join(site, '.flux-docs.json'), 'utf8'));
  assert.deepEqual(manifest.pages, ['index.html', 'modes/figure.html']); checks++;
  assert.deepEqual(await validateDocumentation(site, manifest.pages), manifest.files); checks++;

  for (const failure of [
    async (_source, output) => { await write('index.html', 'partial', output); throw new Error('renderer failed'); },
    async (root, output) => { await render(root, output); await fs.rm(path.join(output, 'site_libs/font.woff2')); return 'fixture'; },
    async (root, output) => { await render(root, output); await fs.rm(path.join(output, 'modes/figure.html')); return 'fixture'; },
    async (root, output) => { await render(root, output); await write('for_agents/private.md', 'private', output); return 'fixture'; },
    async (root, output) => { await render(root, output); await write('site_libs/style.css', 'body{background:url(../../../outside.svg)}', output); return 'fixture'; },
  ]) {
    await assert.rejects(buildDocumentation({ source, render: failure })); checks++;
    assert.deepEqual(await fs.readFile(path.join(site, 'index.html')), saved); checks++;
    ok(!(await fs.readdir(source)).some(name => name.startsWith('.fetch-docs-site-')), 'failed staging removed, good site retained');
  }
  await assert.rejects(buildDocumentation({ source, render, replace: (prepared, target) => replacePrepared(prepared, target, {
    renameImpl: async (from, to) => { if (from === prepared) throw new Error('injected replacement failure'); await fs.rename(from, to); },
  }) }), /injected replacement failure/); checks++;
  assert.deepEqual(await fs.readFile(path.join(site, 'index.html')), saved); checks++;

  const config = yaml.load(await fs.readFile('electron-builder.yml', 'utf8'));
  const opened = [];
  for (const platform of ['mac', 'linux', 'win']) {
    const mapping = config[platform].extraResources.find(item => item.from === 'docs/_site');
    ok(mapping?.to === 'docs', `${platform} has a docs resource mapping despite platform override`);
    const resourcesPath = path.join(scratch, `${platform} package Ω with spaces`, 'resources');
    await fs.mkdir(resourcesPath, { recursive: true });
    await fs.cp(site, path.join(resourcesPath, mapping.to), { recursive: true });
    const options = { packaged: true, resourcesPath, sourceRoot: path.dirname(source) };
    const result = await openDocumentation(options, async target => { opened.push(target); return ''; });
    ok(result.ok && opened.at(-1) === path.join(resourcesPath, 'docs/index.html'), 'native opener targets installed resources, not source checkout');
    assert.deepEqual(await validateDocumentation(path.join(resourcesPath, mapping.to), manifest.pages), manifest.files); checks++;
  }
  ok(config.extraResources.some(item => item.from === 'docs/_site' && item.to === 'docs'), 'default resource map contains docs');
  const sourceOptions = { packaged: false, sourceRoot: path.dirname(source), resourcesPath: '/unused' };
  ok((await openDocumentation(sourceOptions, async target => { assert.equal(target, path.join(site, 'index.html')); return ''; })).ok, 'source checkout opening remains supported');
  const missing = await openDocumentation({ packaged: true, resourcesPath: path.join(scratch, 'missing'), sourceRoot: path.dirname(source) }, async () => { throw new Error('must not open'); });
  ok(!missing.ok && /Bundled documentation/.test(missing.error), 'installed missing help never falls back to source checkout');
  ok(!(await openDocumentation(sourceOptions, async () => 'OS opener refused')).ok, 'OS opener refusal is not success');
  ok(!(await openDocumentation(sourceOptions, async () => { throw new Error('OS opener threw'); })).ok, 'OS opener exception is not success');
  assert.equal(documentationIndex({ packaged: true, resourcesPath: 'C:\\Program Files\\Flux Ω\\resources' }, path.win32), 'C:\\Program Files\\Flux Ω\\resources\\docs\\index.html'); checks++;
  await buildDocumentation({ source, render: async (root, output) => {
    await render(root, output);
    for (const page of ['index.html', 'modes/figure.html']) {
      const file = path.join(output, page), html = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, html.replace('</head>', `<script src="${page.startsWith('modes/') ? '../' : ''}site_libs/quarto-search/quarto-search.js"></script></head>`));
    }
    await write('site_libs/quarto-search/quarto-search.js', 'var fuseIndex = undefined; const kFuseIndexOptions = {keys:["text"]};', output);
    await write('search.json', JSON.stringify([{ href: 'modes/figure.html', text: 'Figure </script> Ω' }]), output);
    return 'fixture-quarto';
  } });
  const searchCode = await fs.readFile(path.join(site, 'site_libs/quarto-search/quarto-search.js'), 'utf8');
  const preload = await fs.readFile(path.join(site, 'site_libs/flux-search-index.js'), 'utf8');
  for (const protocol of ['file:', 'https:']) {
    const context = vm.createContext({ location: { protocol }, window: { Fuse: class { constructor(docs, options) { this.docs = docs; this.options = options; } } } });
    vm.runInContext(searchCode, context); vm.runInContext(preload, context);
    if (protocol === 'file:') {
      assert.equal(vm.runInContext('fuseIndex.docs[0].text', context), 'Figure </script> Ω'); checks++;
      assert.equal(vm.runInContext('fuseIndex.options.keys[0]', context), 'text'); checks++;
    } else { assert.equal(vm.runInContext('fuseIndex', context), undefined); checks++; }
  }
  ok((await fs.readFile(path.join(site, 'modes/figure.html'), 'utf8')).includes('src="../site_libs/flux-search-index.js"'), 'nested pages resolve the bundled file-search index');
  console.log(`Documentation package PASS (${checks} checks): local pages/assets, source and installed paths, failure rollback, native opener results; synthetic platform layouts only.`);
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
