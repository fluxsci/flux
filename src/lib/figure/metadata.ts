/** Metadata edits leave the figure format, panel identities and geometry alone.
 * Expected values guard just the edited fields, so unrelated edits can merge. */
import type { Project } from '../types';
import type { FigureFamilyDef } from '../figfamily';
import * as ops from '../ops';
import { POSTSCRIPT_CAPTION } from '../captions';
export type FigureIdentity = { family: string; number: number; nickname: string };
export type MetadataChange =
  | { kind: 'caption'; figureId: string; key: string; before: string; after: string }
  | { kind: 'identity'; figureId: string; before: FigureIdentity; after: FigureIdentity; family?: FigureFamilyDef };
export function identityOf(f: Project['figures'][number]): FigureIdentity {
  return { family: f.family ?? 'figure', number: f.number ?? 1, nickname: f.nickname ?? '' };
}
export function applyMetadataChange(p: Project, change: MetadataChange): void {
  const f = p.figures.find(f => f.id === change.figureId);
  if (!f) throw new Error('This figure was removed. Your draft has been kept.');
  if (change.kind === 'caption') {
    const current = f.captions?.[change.key] ?? '';
    if (current === change.after) return;
    if (current !== change.before) throw new Error('This caption changed elsewhere. Your draft has been kept; copy it before reloading.');
    if (change.key !== '__figure__' && change.key !== POSTSCRIPT_CAPTION && !f.elements.some(e => e.id === change.key && e.type === 'text' && e.panelLabel))
      throw new Error('This panel label was removed. Your draft has been kept.');
    (f.captions ??= {})[change.key] = change.after;
  } else {
    const current = identityOf(f);
    if (JSON.stringify(current) === JSON.stringify(change.after)) return;
    if (JSON.stringify(current) !== JSON.stringify(change.before)) throw new Error('This figure name or number changed elsewhere. Your draft has been kept.');
    if (change.family && change.family.id === change.after.family) {
      const existing = p.figureFamilies?.find(d => d.id === change.family!.id);
      if (existing && ['displayName', 'refTemplate', 'captionTemplate'].some(key => String(existing[key as keyof FigureFamilyDef]).trim() !== String(change.family![key as keyof FigureFamilyDef]).trim())) throw new Error('This family was defined elsewhere. Choose a different family name.');
      if (!existing) ops.defineFigureFamily(p, change.family);
    }
    ops.setFigureIdentity(p, f.id, change.after);
  }
}
export function reverseMetadataChange(change: MetadataChange): MetadataChange {
  return { ...change, before: change.after, after: change.before } as MetadataChange;
}
