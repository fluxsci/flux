// File-engine scientific alignment. Load only accepted, registered project assets;
// never combine a saved SVG with a newer unsynchronised external source manifest.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mutateFigModel, projectAssetPath, safeId } from './model';
import { ensureDom } from './render';
import { ValidationError, NotFoundError } from './errors';
import { preparePlot } from '../src/lib/plot/parse';
import { validateIncomingPlot } from '../src/lib/plot/contract';
import { resolveLayoutUnits } from '../src/lib/layout/arrangement';
import { applyLayoutTranslations } from '../src/lib/ops';
import { planPlotSpineAlignment, selectionAxisLines, type PlotAxisLines, type SpineAxis, type SpineChoice, type SpineIssue } from '../src/lib/plot/landmarks';
import type { Element, Figure, Project } from '../src/lib/types';
import type { FluxPlotManifest } from '../src/lib/plot/types';

/** The accepted SVG and sidecar of each plot, prepared for landmark reads. `unchanged` is the
 * guard to run after planning and before mutating: a source that changed meanwhile (including
 * its sidecar appearing or disappearing) invalidates whatever was read from it. */
async function acceptedPlotSources(root: string, project: Project, plots: readonly Extract<Element, { type: 'plot' }>[]) {
  const prepared = new Map<string, ReturnType<typeof preparePlot>>();
  const bytes = new Map<string, string | null>();
  await ensureDom();
  for (const plot of plots) {
    if (prepared.has(plot.assetId)) continue;
    safeId('asset', plot.assetId);
    const asset = project.assets.find(a => a.id === plot.assetId);
    if (!asset?.path) continue; // the shared resolver reports unavailable geometry
    const svgPath = await projectAssetPath(root, `fig/${asset.path}`);
    // A plot without a sidecar (a plain SVG) is not an error here: it simply has no semantic
    // axes, which the shared resolver reports as such. Resolving the path of a file that does
    // not exist used to surface as a bare ENOENT instead.
    const absent = (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; };
    const manifestPath = await projectAssetPath(root, `fig/assets/${plot.assetId}.fluxplot.json`).catch(absent);
    const svg = await fs.readFile(svgPath, 'utf8');
    const manifest = manifestPath ? await fs.readFile(manifestPath, 'utf8').catch(absent) : null;
    await validateIncomingPlot(svg, manifest);
    // An absent sidecar is tracked where it would appear, so its creation is a change too.
    bytes.set(svgPath, svg); bytes.set(manifestPath ?? path.join(await fs.realpath(root), 'fig', 'assets', `${plot.assetId}.fluxplot.json`), manifest);
    prepared.set(plot.assetId, preparePlot(svg, manifest ? JSON.parse(manifest) : undefined));
  }
  return {
    manifest: (id: string): FluxPlotManifest | undefined => prepared.get(id)?.manifest,
    plotRoot: (id: string) => prepared.get(id)?.root,
    async unchanged(message: string) {
      for (const [file, original] of bytes) {
        const current = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (current !== original) throw new ValidationError(message);
      }
    },
  };
}

/** Axis lines for `arrange --mode auto` (the app's Crystallize): the same landmarks the editor
 * reads, from the accepted files. A selection that is not all readable plots has none, and the
 * arrangement falls back to bounding boxes; `required` turns an unreadable source into an error
 * instead. The returned guard must run before the mutation is accepted. */
export async function arrangementAxisLines(root: string, project: Project, figure: Figure, ids: readonly string[] | undefined, scope: string | null | undefined, required: boolean): Promise<{ lines: PlotAxisLines; unchanged(): Promise<void> }> {
  const none = { lines: {}, unchanged: async () => {} };
  const units = resolveLayoutUnits(figure, ids, { scope, editable: false });
  if (units.length < 2 || units.some(unit => !unit.members.some(e => e.type === 'plot'))) return none;
  let sources: Awaited<ReturnType<typeof acceptedPlotSources>>;
  try { sources = await acceptedPlotSources(root, project, units.flatMap(unit => unit.members.filter((e): e is Extract<Element, { type: 'plot' }> => e.type === 'plot'))); }
  catch (error) { if (required) throw error; return none; }
  return {
    lines: selectionAxisLines(figure, ids, { figure, scope, manifest: sources.manifest, plotRoot: sources.plotRoot }),
    unchanged: () => sources.unchanged('Plot source changed while preparing the arrangement; retry against the current source'),
  };
}

export interface AlignPlotSpinesOptions {
  ids: string[];
  axis: SpineAxis;
  referenceKey: string;
  scope?: string | null;
  choices?: Record<string, SpineChoice>;
}
export class PlotSpineAlignmentError extends ValidationError {
  constructor(public readonly issues: SpineIssue[]) {
    super(`Plot alignment not applied: ${JSON.stringify({ issues })}`);
  }
}

export async function alignPlotSpines(root: string, figureId: string, options: AlignPlotSpinesOptions) {
  if (!['x', 'y'].includes(options.axis) || !Array.isArray(options.ids) || !options.ids.length || options.ids.some(id => typeof id !== 'string') || typeof options.referenceKey !== 'string') throw new ValidationError('Plot alignment requires explicit ids, axis x/y and a referenceKey');
  return mutateFigModel(root, 'align_plot_spines', async ({ project }) => {
    const figure = project.figures.find(f => f.id === figureId);
    if (!figure) throw new NotFoundError(`figure not found: ${figureId}`);
    if (options.ids.some(id => !figure.elements.some(e => e.id === id))) throw new ValidationError('Every plot alignment target must belong to the requested figure');
    const units = resolveLayoutUnits(figure, options.ids, { scope: options.scope, editable: false });
    const sources = await acceptedPlotSources(root, project, units.flatMap(unit => unit.members.filter((e): e is Extract<Element, { type: 'plot' }> => e.type === 'plot')));
    const plan = planPlotSpineAlignment(units, options.axis, options.referenceKey, {
      figure, scope: options.scope, manifest: sources.manifest, plotRoot: sources.plotRoot,
    }, options.choices);
    if (plan.issues.length) throw new PlotSpineAlignmentError(plan.issues);
    // Source IO happens before mutation. A source that changed while preparing the
    // plan invalidates it, including creation/removal of its accepted sidecar.
    await sources.unchanged('Plot source changed while preparing alignment; retry against the current source');
    const moved = plan.translations.filter(t => t.dx !== 0 || t.dy !== 0).map(t => t.id);
    if (moved.length) applyLayoutTranslations(project, figureId, plan.translations);
    return { figureId, axis: options.axis, referenceKey: options.referenceKey, moved, landmarks: plan.landmarks };
  }, { changed: result => result.moved.length > 0 });
}
