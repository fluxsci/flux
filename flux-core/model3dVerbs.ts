import { z } from 'zod';
import type { VerbDef, CliArgSpec } from './registry';
import { addModel, modelInfo, setModelViewCommand, setModelFieldCommand, renderModelPosters } from './model3d';
import { MODEL_VIEW_PRESETS, type ModelViewCommand, type ModelFieldCommand } from '../src/lib/model3d/commandOps';

const finite = () => z.number().finite();
// ZodRecord intentionally drops __proto__ on ordinary object output. GLB shape
// names are arbitrary strings: temporarily prefix every key while validating,
// then rebuild own data properties without a prototype assignment.
const states = z.preprocess(value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).map(([name, weight]) => [`:${name}`, weight])) : value,
z.record(finite())).transform(value => Object.fromEntries(Object.entries(value).map(([name, weight]) => [name.slice(1), weight])));
const viewParams = {
  azimuth: finite().optional(), elevation: finite().optional(), roll: finite().optional(), zoom: finite().optional(),
  panX: finite().optional(), panY: finite().optional(), fov: finite().optional(),
  projection: z.enum(['orthographic', 'perspective']).optional(), color: z.string().min(1).optional(),
  colors: z.enum(['source', 'uniform']).optional(), lighting: z.enum(['studio', 'unlit']).optional(),
  preset: z.enum(MODEL_VIEW_PRESETS).optional(), states: states.optional(), frame: finite().optional(),
};
// Figure targets only: deck/slide selectors return with the Slides phase (P4),
// so the schemas never advertise parameters that always fail.
const targetParams = { target: z.string(), figureId: z.string().optional(), noPoster: z.boolean().optional() };
const target = (args: Record<string, unknown>) => ({ target: String(args.target), figureId: args.figureId as string | undefined, noPoster: args.noPoster as boolean | undefined });
const targetArgs: CliArgSpec[] = [{ kind: 'pos', at: 0, into: 'target', required: true }, { kind: 'flag', at: 'figure', into: 'figureId' }, { kind: 'flag', at: 'no-poster', into: 'noPoster', as: 'boolean' }];

export const MODEL3D_VERBS: VerbDef[] = [
  {
    name: 'add_model', cli: 'add-model', cliRoot: 'flags', scope: 'project',
    summary: 'Import a triangle GLB into a Figure with scene3d metadata, physical size and source provenance. Returns element/asset ids, semantic parts, warnings and a derived poster.',
    params: { figureId: z.string(), sourcePath: z.string(), name: z.string().optional(), noPoster: z.boolean().optional(),
      box: z.object({ x: finite().optional(), y: finite().optional(), width: finite().positive().optional(), height: finite().positive().optional() }).optional(), view: z.object(viewParams).optional() },
    pathParams: { sourcePath: 'path' },
    cliArgs: [{ kind: 'pos', at: 0, into: 'figureId', required: true }, { kind: 'pos', at: 1, into: 'sourcePath', required: true },
      ...['x', 'y', 'width', 'height'].map(at => ({ kind: 'flag' as const, at, into: `box.${at}`, as: 'number' as const })),
      { kind: 'flag', at: 'name', into: 'name' }, { kind: 'flag', at: 'no-poster', into: 'noPoster', as: 'boolean' }, { kind: 'flag', at: 'view', into: 'view', as: 'json' }],
    handler: (ctx, a) => addModel(ctx.root, String(a.figureId), String(a.sourcePath), { box: a.box as NonNullable<Parameters<typeof addModel>[3]>['box'], view: a.view as ModelViewCommand | undefined, name: a.name as string | undefined, noPoster: a.noPoster as boolean | undefined }),
  },
  {
    name: 'set_model_view', cli: 'set-model-view', cliRoot: 'flags', scope: 'project',
    summary: 'Edit a Figure model camera, lighting, source/uniform colors or named shape weights. Preset is applied first; explicit values patch it. --state name=weight repeats; finite stored weights may extrapolate. Frame requires a sequence. Slide targets await the Slides integration.',
    params: { ...targetParams, ...viewParams },
    cliArgs: [...targetArgs,
      ...['azimuth', 'elevation', 'roll', 'zoom', 'fov', 'frame'].map(at => ({ kind: 'flag' as const, at, into: at, as: 'number' as const })),
      { kind: 'flag', at: 'pan-x', into: 'panX', as: 'number' }, { kind: 'flag', at: 'pan-y', into: 'panY', as: 'number' },
      ...['projection', 'color', 'colors', 'lighting', 'preset'].map(at => ({ kind: 'flag' as const, at, into: at })),
      { kind: 'flag', at: 'state', into: 'states', repeat: true, as: 'keyValueNumbers' }],
    handler: (ctx, a) => setModelViewCommand(ctx.root, target(a), a as ModelViewCommand),
  },
  {
    name: 'set_model_field', cli: 'set-model-field', cliRoot: 'flags', scope: 'project',
    summary: 'Remap an addressable 3D value field with a colormap/range, or reset its overrides. Activates source colors and preserves explicit part fills. Other fields remain unchanged.',
    params: { ...targetParams, field: z.string(), cmap: z.string().optional(), min: finite().optional(), max: finite().optional(), reset: z.boolean().optional() },
    cliArgs: [...targetArgs, { kind: 'pos', at: 1, into: 'field', required: true }, { kind: 'flag', at: 'cmap', into: 'cmap' },
      { kind: 'flag', at: 'min', into: 'min', as: 'number' }, { kind: 'flag', at: 'max', into: 'max', as: 'number' }, { kind: 'flag', at: 'reset', into: 'reset', as: 'boolean' }],
    handler: (ctx, a) => setModelFieldCommand(ctx.root, target(a), a as unknown as ModelFieldCommand),
  },
  {
    name: 'model_info', cli: 'model-info', cliRoot: 'flags', scope: 'file', readOnly: true,
    summary: 'Inspect a GLB without importing or rendering: geometry limits, bounds, semantic parts/fields, named shapes, topology, warnings or a refusal reason. --morph-with compares ordered topology with another GLB.',
    params: { path: z.string(), morphWith: z.string().optional() }, pathParams: { path: 'path', morphWith: 'path' },
    cliArgs: [{ kind: 'pos', at: 0, into: 'path', required: true }, { kind: 'flag', at: 'morph-with', into: 'morphWith' }],
    handler: (_ctx, a) => modelInfo(String(a.path), { morphWith: a.morphWith as string | undefined }),
  },
  {
    name: 'render_model_posters', cli: 'render-model-posters', cliRoot: 'flags', scope: 'project',
    summary: 'Render saved Figure model views into the project poster cache using a batched native worker. Optional figure filter; prune removes only unreferenced posters older than 14 days and bounds the machine cache (14 days, 1 GiB). Ordinary Connect reads never render or write these caches.',
    params: { figureId: z.string().optional(), prune: z.boolean().optional() },
    cliArgs: [{ kind: 'flag', at: 'figure', into: 'figureId' }, { kind: 'flag', at: 'prune', into: 'prune', as: 'boolean' }],
    handler: (ctx, a) => renderModelPosters(ctx.root, { figureId: a.figureId as string | undefined, prune: a.prune as boolean | undefined, signal: ctx.signal }),
  },
];
