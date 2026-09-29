/** Published neural-populations fixture only; never reads an owner's checkout. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const SOURCE = Object.freeze({ repo: 'https://github.com/fluxsci/fluxsci.github.io', commit: '0f5546baa27617c22eeb112b4ca46407516508e1', tree: 'b1dba6eebe3889e84a090b09d3840f5e4b6abb3c', prefix: 'examples/neural-populations' });
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
/** Recompute the Git tree from the receipt, rather than trusting claimed provenance. */
export function publicTreeHash(files) {
  const root = new Map();
  for (const file of files) {
    if (!['100644', '100755'].includes(file.mode) || !/^[a-f0-9]{40}$/.test(file.gitBlob) || file.path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Unsafe public Git receipt');
    let node = root;
    const parts = file.path.split('/');
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
      if (!(node instanceof Map)) throw Error('Conflicting public Git paths');
    }
    const name = parts.at(-1);
    if (node.has(name)) throw Error('Duplicate public Git path');
    node.set(name, file);
  }
  const treeHash = node => {
    const entries = [...node].map(([name, value]) => value instanceof Map
      ? { name, sort: name + '/', mode: '40000', hash: treeHash(value) }
      : { name, sort: name, mode: value.mode, hash: value.gitBlob });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
    const bytes = Buffer.concat(entries.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.hash, 'hex')]));
    return digest('sha1', Buffer.concat([Buffer.from(`tree ${bytes.length}\0`), bytes]));
  };
  return treeHash(root);
}
function confined(directory) {
  const root = path.resolve(directory);
  if (!root.startsWith(os.tmpdir() + path.sep)) throw Error('S8 fixtures must live under scratch /tmp; owner projects are forbidden');
  return root;
}
export async function fetchPublicS8Fixture(directory) {
  const root = confined(directory); await fs.mkdir(root, { recursive: true });
  if (await fs.realpath(root) !== root || (await fs.readdir(root)).length) throw Error('Public example download needs an empty real scratch directory');
  const { files } = JSON.parse(await fs.readFile(new URL('../fixtures/model3d/s8-public-tree.json', import.meta.url), 'utf8'));
  if (publicTreeHash(files) !== SOURCE.tree || files.length !== 369 || files.reduce((sum, e) => sum + e.bytes, 0) !== 57462899) throw Error('Published example inventory changed unexpectedly');
  const pending = [...files], receipts = [];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (pending.length) {
      const file = pending.shift();
      if (!file || !['100644', '100755'].includes(file.mode) || file.path.startsWith('/') || file.path.split('/').some(p => p === '..' || p === '')) throw Error('Unsafe public example entry');
      const url = `https://raw.githubusercontent.com/fluxsci/fluxsci.github.io/${SOURCE.commit}/${SOURCE.prefix}/${file.path}`;
      const response = await fetch(url); if (!response.ok) throw Error(`Published example ${file.path}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== file.bytes || digest('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])) !== file.gitBlob) throw Error(`Published Git blob mismatch: ${file.path}`);
      const destination = path.join(root, file.path); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes);
      receipts.push({ ...file, sha256: digest('sha256', bytes) });
    }
  }));
  receipts.sort((a, b) => a.path.localeCompare(b.path));
  const receipt = { ...SOURCE, count: receipts.length, bytes: receipts.reduce((n, f) => n + f.bytes, 0), files: receipts };
  await fs.writeFile(path.join(root, 'public-source-receipt.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
export async function verifyPublicS8Fixture(directory) {
  const root = confined(directory);
  if(await fs.realpath(root)!==root || !(await fs.lstat(root)).isDirectory())throw Error('S8 cache must be a real scratch directory');
  const receiptPath=path.join(root,'public-source-receipt.json');
  if(!(await fs.lstat(receiptPath)).isFile() || await fs.realpath(receiptPath)!==receiptPath)throw Error('S8 receipt must be a regular confined file');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  if (receipt.commit !== SOURCE.commit || receipt.tree !== SOURCE.tree || receipt.count !== 369 || receipt.files.length !== 369 || publicTreeHash(receipt.files) !== SOURCE.tree) throw Error('S8 example provenance is not the pinned public fixture');
  for (const file of receipt.files) {
    const destination = path.resolve(root, file.path);
    if (!destination.startsWith(root + path.sep) || !(await fs.lstat(destination)).isFile() || await fs.realpath(destination) !== destination) throw Error('Unsafe S8 fixture path');
    const bytes = await fs.readFile(destination);
    if (bytes.length !== file.bytes || digest('sha256', bytes) !== file.sha256 || digest('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])) !== file.gitBlob) throw Error(`S8 fixture bytes changed: ${file.path}`);
  }
  return receipt;
}
