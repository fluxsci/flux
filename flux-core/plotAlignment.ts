// File-engine scientific alignment. Load only accepted, registered project assets;
// never combine a saved SVG with a newer unsynchronised external source manifest.
import * as fs from 'node:fs/promises';
import { mutateFigModel, projectAssetPath, safeId } from './model';
import { ensureDom } from './render';
import { ValidationError, NotFoundError } from './errors';
import { preparePlot } from '../src/lib/plot/parse';
import { validateIncomingPlot } from '../src/lib/plot/contract';
import { resolveLayoutUnits } from '../src/lib/layout/arrangement';
import { applyLayoutTranslations } from '../src/lib/ops';
import { planPlotSpineAlignment, type SpineAxis, type SpineChoice, type SpineIssue } from '../src/lib/plot/landmarks';

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
    const plots = units.flatMap(unit => unit.members.filter(e => e.type === 'plot'));
    const prepared = new Map<string, ReturnType<typeof preparePlot>>();
    const bytes = new Map<string, string | null>();
    await ensureDom();
    for (const plot of plots) {
      if (prepared.has(plot.assetId)) continue;
      safeId('asset', plot.assetId);
      const asset = project.assets.find(a => a.id === plot.assetId);
      if (!asset?.path) continue; // the shared resolver reports unavailable geometry
      const svgPath = await projectAssetPath(root, `fig/${asset.path}`);
      const manifestPath = await projectAssetPath(root, `fig/assets/${plot.assetId}.fluxplot.json`);
      const svg = await fs.readFile(svgPath, 'utf8');
      const manifest = await fs.readFile(manifestPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      await validateIncomingPlot(svg, manifest);
      bytes.set(svgPath, svg); bytes.set(manifestPath, manifest);
      prepared.set(plot.assetId, preparePlot(svg, manifest ? JSON.parse(manifest) : undefined));
    }
    const plan = planPlotSpineAlignment(units, options.axis, options.referenceKey, {
      figure, scope: options.scope, manifest: id => prepared.get(id)?.manifest, plotRoot: id => prepared.get(id)?.root,
    }, options.choices);
    if (plan.issues.length) throw new PlotSpineAlignmentError(plan.issues);
    // Source IO happens before mutation. A source that changed while preparing the
    // plan invalidates it, including creation/removal of its accepted sidecar.
    for (const [file, original] of bytes) {
      const current = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (current !== original) throw new ValidationError('Plot source changed while preparing alignment; retry against the current source');
    }
    const moved = plan.translations.filter(t => t.dx !== 0 || t.dy !== 0).map(t => t.id);
    if (moved.length) applyLayoutTranslations(project, figureId, plan.translations);
    return { figureId, axis: options.axis, referenceKey: options.referenceKey, moved, landmarks: plan.landmarks };
  }, { changed: result => result.moved.length > 0 });
}
