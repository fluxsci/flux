// The figure rollup is part of the same recoverable generation as its canvases.
// Callers hold project -> (slides, if recovering a shared journal) -> manifest.
import { kindForFamily } from '../figfamily';
import type { FigIndexFile } from './figfiles';
import { decodeManifest, encodeManifest } from './manifestTransaction';
import type { GenerationWrite, TextGenerationIO } from './textGeneration';

export async function stageFigureRegistration(io: Pick<TextGenerationIO, 'read'>, index: FigIndexFile, writes: Map<string, GenerationWrite>): Promise<void> {
  const before = await io.read('project.json');
  if (before === null) throw new Error('Figure publication requires project.json');
  const manifest = decodeManifest(before), original = JSON.stringify(manifest);
  const entries = new Map(manifest.figures.map(f => [f.id, f]));
  manifest.figures = index.figures.map(f => ({
    ...entries.get(f.id), id: f.id, name: f.name, label: f.label, order: f.order,
    kind: f.family ? kindForFamily(f.family) : f.kind === 'supplementary' ? 'supplementary' : 'main',
    family:f.family, number:f.number, nickname:f.nickname, canvas:f.canvas, caption:`fig/captions/${f.id}.md`,
  }));
  manifest.figureFamilies = index.families ?? [];
  if (JSON.stringify(manifest) !== original) {
    manifest.modified = new Date().toISOString();
    writes.set('project.json', encodeManifest(manifest));
  }
}
