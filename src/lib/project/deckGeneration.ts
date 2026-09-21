// Shared deck publication for the GUI and headless engine. The adapter holds
// project → slides → manifest leases. No cache/baseline changes happen here.
import type { Deck } from '../slide/types';
import { decodeManifest, encodeManifest } from './manifestTransaction';
import { validateDeckFile } from './validate';
import { commitTextGeneration, type GenerationWrite, type TextGenerationIO } from './textGeneration';
export function stageDeckRegistration(manifest: ReturnType<typeof decodeManifest>, deck: Deck): string {
  manifest.slides ??= [];
  const n = manifest.slides.findIndex(s => s.id === deck.id), prior = n < 0 ? undefined : manifest.slides[n];
  const entry = { ...prior, id: deck.id, path: prior?.path ?? `slides/${deck.id}/deck.json`, title: deck.title, order: prior?.order ?? (n < 0 ? manifest.slides.length + 1 : n + 1) };
  if (n < 0) manifest.slides.push(entry); else manifest.slides[n] = entry;
  return entry.path;
}
export async function commitDeckGeneration(io: TextGenerationIO, input: Deck, opts: {
  writes?: ReadonlyMap<string, GenerationWrite>;
  expectedText?: string | null;
  expectedPath?: string;
  assertOwned?: () => Promise<void>;
} = {}): Promise<{ path: string; text: string; deck: Deck }> {
  const errors = validateDeckFile(input); if (errors.length) throw new Error(errors.join('; '));
  // JSON silently turns NaN/Infinity in extension/animation fields into null.
  JSON.stringify(input, (key, value) => { if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Deck ${key} must be finite`); return value; });
  const deck = structuredClone(input), manifestText = await io.read('project.json');
  if (manifestText === null) throw new Error('Deck publication requires project.json');
  const manifest = decodeManifest(manifestText), beforeRegistration = JSON.stringify(manifest);
  const path = stageDeckRegistration(manifest, deck);
  if (opts.expectedPath !== undefined && path !== opts.expectedPath) throw new Error('Deck registration changed while preparing publication');
  const before = await io.read(path);
  if (opts.expectedText !== undefined && before !== opts.expectedText) throw new Error('Deck changed while preparing publication');
  const same = (a: string, b: string) => { try { const x=JSON.parse(a),y=JSON.parse(b);delete x.modified;delete y.modified;return JSON.stringify(x)===JSON.stringify(y); } catch { return false; } };
  const serialized = JSON.stringify(deck, null, 2) + '\n';
  let text = before !== null && same(before, serialized) ? before : '';
  if (!text) { deck.modified = new Date().toISOString(); text = JSON.stringify(deck, null, 2) + '\n'; }
  else deck.modified = JSON.parse(text).modified;
  const writes = new Map(opts.writes);
  writes.set(path, text);
  if (JSON.stringify(manifest) !== beforeRegistration) {
    manifest.modified = new Date().toISOString();
    writes.set('project.json', encodeManifest(manifest));
  }
  await opts.assertOwned?.();
  if (await io.read('project.json') !== manifestText || await io.read(path) !== before) throw new Error('Deck or manifest changed before publication');
  await commitTextGeneration(io, writes, opts.assertOwned);
  return { path, text, deck };
}
