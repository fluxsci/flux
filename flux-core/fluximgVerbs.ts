import { z } from 'zod';
import type { VerbDef } from './registry';
import { text } from './registry';
import { placeImage, setImageView, imageInfo } from './fluximg';

// N-dimensional images (fluximg) on Figure canvases. The view is a SPARSE recipe: only what differs from the
// image's defaults is stored, null clears a setting. Pixels are never changed by any of these.
const finite = () => z.number().finite();
const crop = z.object({ x: finite(), y: finite(), width: finite().positive(), height: finite().positive() });
const view = z.record(z.unknown());

type Summary = { elementId: string; name: string | null; position: string[]; showing: string[]; objects?: string[]; warnings?: string[] };
const words = (r: Summary): string => [
  r.position.length ? `at ${r.position.join(', ')}` : '',
  r.showing.length ? `showing ${r.showing.join('; ')}` : '',
  r.objects?.length ? `objects: ${r.objects.join('; ')}` : '',
  ...(r.warnings ?? []).map(w => `⚠ ${w}`),
].filter(Boolean).join('\n');

export const FLUXIMG_VERBS: VerbDef[] = [
  {
    name: 'place_image', cli: 'place-image', cliRoot: 'flags', scope: 'project',
    summary: 'Place an N-dimensional image (a .fluximg bundle) on a Figure. The bundle folder (written by fluxplot) is copied into fig/assets once (a bundle whose content is already in the project is reused, not copied), adds an image element and answers with its resolved view. Optional x/y/width (canvas px; height follows the aspect), crop {x,y,width,height} in image pixels, and a sparse view such as {"index":{"z":12},"channels":[{"range":[100,4000]}],"furniture":{"scalebar":{}}}. Refuses a slide deck.',
    params: { figureId: z.string(), bundlePath: z.string(), x: finite().optional(), y: finite().optional(), width: finite().positive().optional(), name: z.string().optional(), crop: crop.optional(), view: view.optional() },
    pathParams: { bundlePath: 'path' },
    cliArgs: [{ kind: 'pos', at: 0, into: 'figureId', required: true }, { kind: 'pos', at: 1, into: 'bundlePath', required: true },
      ...['x', 'y', 'width'].map(at => ({ kind: 'flag' as const, at, into: at, as: 'number' as const })),
      { kind: 'flag', at: 'name', into: 'name' }, { kind: 'flag', at: 'crop', into: 'crop', as: 'json' }, { kind: 'flag', at: 'view', into: 'view', as: 'json' }],
    handler: (ctx, a) => placeImage(ctx.root, String(a.figureId), String(a.bundlePath), { x: a.x as number | undefined, y: a.y as number | undefined, width: a.width as number | undefined, name: a.name as string | undefined, crop: a.crop, view: a.view }),
    render: {
      human: r => { const v = r as Summary & { assetId: string; reused: boolean; image: string }; return { out: JSON.stringify(r, null, 2), err: `✓ placed image ${v.elementId} (${v.image}; asset ${v.assetId}${v.reused ? ', already in the project: not copied again' : ''})${words(v) ? `\n${words(v)}` : ''}` }; },
      mcp: r => { const v = r as Summary & { assetId: string; reused: boolean; image: string }; return text(`placed image ${v.elementId} (${v.image}; asset ${v.assetId}${v.reused ? ', reused' : ''})\n${words(v)}\n${JSON.stringify(r)}`); },
    },
  },
  {
    name: 'set_image_view', cli: 'set-image-view', cliRoot: 'flags', scope: 'project',
    summary: 'Change how a placed image is shown, never its pixels. view is a sparse patch merged into the stored one (null clears a setting): index {dim: plane}, projection {dim, mode: max|mean|min|sum|std, from, to (exclusive)} or null, channels [per channel: visible, color "#rrggbb" or lut name, range [black, white] in value units, norm linear|log|gamma, gamma, invert], composite blend|single + solo, background, smooth, layers {id: visible, opacity, color, strokeWidth, fillOpacity, range, styleBy {color {column, lut?, palette?, range?, reverse?}, opacity {column, range?, to?}, missing dim|hide}}, layerOrder, furniture {scalebar, stamp, channelLabels, names, colorbar, key: {} on, false off}. crop {x,y,width,height} in image pixels (or null / --reset-crop) keeps the content pinned on the canvas. Every key is checked against the image first; answers with the RESOLVED view and its position in words.',
    params: { id: z.string(), view: view.optional(), crop: crop.nullable().optional() },
    cliArgs: [{ kind: 'pos', at: 0, into: 'id', required: true }, { kind: 'flag', at: 'view', into: 'view', as: 'json' },
      { kind: 'flag', at: 'crop', into: 'crop', as: 'json' }, { kind: 'flag', at: 'reset-crop', into: 'crop', const: null }],
    handler: (ctx, a) => setImageView(ctx.root, String(a.id), a.view, a.crop === undefined ? {} : { crop: a.crop }),
    render: {
      human: r => ({ out: JSON.stringify(r, null, 2), err: `✓ set the view of image ${(r as Summary).elementId}${words(r as Summary) ? `\n${words(r as Summary)}` : ''}` }),
      mcp: r => text(`set the view of image ${(r as Summary).elementId}\n${words(r as Summary)}\n${JSON.stringify(r)}`),
    },
  },
  {
    name: 'image_info', cli: 'image-info', cliRoot: 'flags', scope: 'project', readOnly: true,
    summary: 'Describe an N-dimensional image, or how an element shows it, without rendering. Takes an image element id (adds that element\'s box, crop, stored and resolved view, position in words such as "z 12/21 · −50.5 µm", and export size) or a fluximg asset id, and reports dimensions with units and positions, dtype and encoding, levels, channels with default ranges, min/max and percentiles (to choose contrast), layers with object counts and table columns (kind, distinct values, range: what styleBy can use), regions, and every placement.',
    params: { target: z.string() },
    cliArgs: [{ kind: 'pos', at: 0, into: 'target', required: true }],
    handler: (ctx, a) => imageInfo(ctx.root, String(a.target)),
    render: {
      human: r => ({ out: JSON.stringify(r, null, 2) }),
      mcp: r => text(JSON.stringify(r, null, 2)),
    },
  },
];
