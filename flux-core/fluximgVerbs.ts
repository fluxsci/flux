import { z } from 'zod';
import type { CliArgSpec, VerbDef } from './registry';
import type { TiffFlags } from './tiffPlace';
import { text } from './registry';
import { placeImage, setImageView, imageInfo } from './fluximg';

// N-dimensional images (fluximg) on Figure canvases and slides (a deck refers to the project's bundle by id). The view is a SPARSE recipe: only what differs from the
// image's defaults is stored, null clears a setting. Pixels are never changed by any of these.
const finite = () => z.number().finite();
const crop = z.object({ x: finite(), y: finite(), width: finite().positive(), height: finite().positive() });
const view = z.record(z.unknown());
// How a TIFF's pages are read (flux-core/tiffPlace.ts); every field optional, the CLI flags map onto it.
const tiff = z.object({
  dims: z.string().optional(), transpose: z.boolean().optional(), flipX: z.boolean().optional(), flipY: z.boolean().optional(),
  pixelSize: finite().positive().optional(), unit: z.string().optional(), dt: finite().positive().optional(), rate: finite().positive().optional(),
  zStep: finite().positive().optional(), nodata: finite().optional(), lossless: z.boolean().optional(),
  channels: z.union([z.array(z.string()), z.string()]).optional(), answer: z.unknown().optional(),
});
const TIFF_FLAGS: CliArgSpec[] = [
  { kind: 'flag', at: 'dims', into: 'tiff.dims' }, { kind: 'flag', at: 'transpose', into: 'tiff.transpose', as: 'boolean' },
  { kind: 'flag', at: 'flip-x', into: 'tiff.flipX', as: 'boolean' }, { kind: 'flag', at: 'flip-y', into: 'tiff.flipY', as: 'boolean' },
  { kind: 'flag', at: 'pixel-size', into: 'tiff.pixelSize', as: 'number' }, { kind: 'flag', at: 'unit', into: 'tiff.unit' },
  { kind: 'flag', at: 'dt', into: 'tiff.dt', as: 'number' }, { kind: 'flag', at: 'rate', into: 'tiff.rate', as: 'number' },
  { kind: 'flag', at: 'z-step', into: 'tiff.zStep', as: 'number' }, { kind: 'flag', at: 'nodata', into: 'tiff.nodata', as: 'number' },
  { kind: 'flag', at: 'lossless', into: 'tiff.lossless', as: 'boolean' }, { kind: 'flag', at: 'channels', into: 'tiff.channels', as: 'csv' },
  { kind: 'flag', at: 'answer', into: 'tiff.answer', as: 'json' },
];

type Summary = { elementId: string; name: string | null; position: string[]; showing: string[]; objects?: string[]; warnings?: string[] };
const words = (r: Summary): string => [
  r.position.length ? `at ${r.position.join(', ')}` : '',
  r.showing.length ? `showing ${r.showing.join('; ')}` : '',
  r.objects?.length ? `objects: ${r.objects.join('; ')}` : '',
  ...(r.warnings ?? []).map(w => `⚠ ${w}`),
].filter(Boolean).join('\n');

type Movie = { path: string; elementId: string; frames: number; durationMs: number; fps: number; width: number; height: number; bytes: number; dim: string; from: number; to: number; mode: string; speed: number; blend: boolean; warnings: string[] };
const movieWords = (m: Movie): string => `${m.frames} frames · ${(m.durationMs / 1000).toFixed(2)} s at ${Number(m.fps.toPrecision(4))} fps · ${m.width} × ${m.height} · ${(m.bytes / 1024).toFixed(0)} KB; ${m.dim} ${m.from + 1}–${m.to}, ${m.mode}${m.speed !== 1 ? `, ×${m.speed}` : ''}${m.blend ? ', blended' : ''}`;

export const FLUXIMG_VERBS: VerbDef[] = [
  {
    name: 'place_image', cli: 'place-image', cliRoot: 'flags', scope: 'project',
    summary: 'Place an N-dimensional image (a .fluximg bundle) on a figure or slide. The target is a figure id, deckId/slideId or a slide id. The bundle folder (written by fluxplot) is copied into fig/assets once (a bundle whose content is already in the project is reused, not copied), adds an image element and answers with its resolved view. Optional x/y/width (canvas px; height follows the aspect), crop {x,y,width,height} in image pixels, and a sparse view such as {"index":{"z":12},"channels":[{"range":[100,4000]}],"furniture":{"scalebar":{}}}. On a slide the default size fits the stage. A .tif/.tiff is converted first: with clear metadata (OME, ImageJ, per-page JSON, named shape) it needs nothing more; otherwise it refuses with ranked proposals and the flags that pick each: tiff {dims "t,c=2" slowest first (one size may be rest), transpose, flipX, flipY, pixelSize + unit, dt or rate, zStep, nodata, lossless, channels} or tiff.answer (a full answer as image-info proposes).',
    notAPath: { figureId: 'Figure id, deckId/slideId or slide id, not a filesystem path' },
    params: { figureId: z.string(), bundlePath: z.string(), x: finite().optional(), y: finite().optional(), width: finite().positive().optional(), name: z.string().optional(), crop: crop.optional(), view: view.optional(), tiff: tiff.optional() },
    pathParams: { bundlePath: 'path' },
    cliArgs: [{ kind: 'pos', at: 0, into: 'figureId', required: true }, { kind: 'pos', at: 1, into: 'bundlePath', required: true },
      ...['x', 'y', 'width'].map(at => ({ kind: 'flag' as const, at, into: at, as: 'number' as const })),
      { kind: 'flag', at: 'name', into: 'name' }, { kind: 'flag', at: 'crop', into: 'crop', as: 'json' }, { kind: 'flag', at: 'view', into: 'view', as: 'json' },
      ...TIFF_FLAGS],
    handler: (ctx, a) => placeImage(ctx.root, String(a.figureId), String(a.bundlePath), { x: a.x as number | undefined, y: a.y as number | undefined, width: a.width as number | undefined, name: a.name as string | undefined, crop: a.crop, view: a.view, tiff: a.tiff as TiffFlags | undefined }),
    render: {
      human: r => { const v = r as Summary & { assetId: string; reused: boolean; image: string }; return { out: JSON.stringify(r, null, 2), err: `✓ placed image ${v.elementId} (${v.image}; asset ${v.assetId}${v.reused ? ', already in the project: not copied again' : ''})${words(v) ? `\n${words(v)}` : ''}` }; },
      mcp: r => { const v = r as Summary & { assetId: string; reused: boolean; image: string }; return text(`placed image ${v.elementId} (${v.image}; asset ${v.assetId}${v.reused ? ', reused' : ''})\n${words(v)}\n${JSON.stringify(r)}`); },
    },
  },
  {
    name: 'set_image_view', cli: 'set-image-view', cliRoot: 'flags', scope: 'project',
    summary: 'Change how a placed image is shown, never its pixels. view is a sparse patch merged into the stored one (null clears a setting): index {dim: plane}, projection {dim, mode: max|mean|min|sum|std, from, to (exclusive)} or null, channels [per channel: visible, color "#rrggbb" or lut name, range [black, white] in value units, norm linear|log|gamma, gamma, invert], composite blend|single + solo, background, smooth, layers {id: visible, opacity, color, strokeWidth, fillOpacity, range, styleBy {color {column, lut?, palette?, range?, reverse?}, opacity {column, range?, to?}, missing dim|hide}}, layerOrder, furniture {scalebar, stamp, channelLabels, names, colorbar, key: {} on, false off}. crop {x,y,width,height} in image pixels (or null / --reset-crop) keeps the content pinned on the canvas. An image on a slide needs slide (deckId/slideId); with beat (a build step after Design) the edit becomes that step\'s Change, as "Edit after step" does in the app (stored as a patch over the view before the step, so Design edits it does not touch carry through): the image glides from its earlier state to this one; a walk of planes is timed at the data\'s own pace times speed (default 1), blend crossfades its planes. playback {dim, mode: loop|bounce|once, speed?, fps?, from?, to? (exclusive)} (or null) sets how it plays as a movie once a step starts it (set-video-track); it is Design-level. Every key is checked against the image first; answers with the RESOLVED view and its position in words.',
    params: { id: z.string(), view: view.optional(), crop: crop.nullable().optional(), slide: z.string().optional(), beatId: z.string().optional(), speed: finite().positive().optional(), blend: z.boolean().optional(), playback: z.record(z.unknown()).nullable().optional() },
    notAPath: { slide: 'deckId/slideId, not a filesystem path' },
    cliArgs: [{ kind: 'pos', at: 0, into: 'id', required: true }, { kind: 'flag', at: 'view', into: 'view', as: 'json' },
      { kind: 'flag', at: 'crop', into: 'crop', as: 'json' }, { kind: 'flag', at: 'reset-crop', into: 'crop', const: null },
      { kind: 'flag', at: 'slide', into: 'slide' }, { kind: 'flag', at: 'beat', into: 'beatId' },
      { kind: 'flag', at: 'speed', into: 'speed', as: 'number' }, { kind: 'flag', at: 'blend', into: 'blend', as: 'boolean' }, { kind: 'flag', at: 'playback', into: 'playback', as: 'json' }],
    handler: (ctx, a) => setImageView(ctx.root, String(a.id), a.view, {
      ...(a.crop === undefined ? {} : { crop: a.crop }),
      ...(typeof a.slide === 'string' ? { slide: a.slide } : {}), ...(typeof a.beatId === 'string' ? { beatId: a.beatId } : {}),
      ...(typeof a.speed === 'number' ? { speed: a.speed } : {}), ...(typeof a.blend === 'boolean' ? { blend: a.blend } : {}), ...(a.playback !== undefined ? { playback: a.playback } : {}) }),
    render: {
      human: r => ({ out: JSON.stringify(r, null, 2), err: `✓ set the view of image ${(r as Summary).elementId}${(r as { beatId?: string }).beatId ? ` at step ${(r as { beatId?: string }).beatId}` : ''}${words(r as Summary) ? `\n${words(r as Summary)}` : ''}` }),
      mcp: r => text(`set the view of image ${(r as Summary).elementId}\n${words(r as Summary)}\n${JSON.stringify(r)}`),
    },
  },
  {
    name: 'export_image_movie', cli: 'export-image-movie', cliRoot: 'flags', scope: 'project',
    summary: 'Write an image\'s movie as an MP4. The element as drawn (crop, view, styled layers, furniture with the stamp advancing) played along dim (default: its playback dimension, else time, else depth) over planes from..to (exclusive; default its playback range, else all), at the data\'s own rate (else the playback fps, else 12 a second) or fps planes a second, times speed; mode once (default) or bounce (there and back once); blend crossfades planes as a Change does. Size: the cropped image\'s pixels times scale (default 1), never below the element\'s box while it shows words, longest side at most 2160. H.264 + faststart, BT.709 as slide videos. On a slide pass slide (deckId/slideId); beat takes the image as it stands after that step. Needs the bundled video encoder; answers with the file, frames, duration, size and rate.',
    params: { elementId: z.string(), out: z.string(), slide: z.string().optional(), beatId: z.string().optional(), dim: z.string().optional(), from: z.number().int().min(0).optional(), to: z.number().int().min(1).optional(),
      speed: finite().positive().optional(), fps: finite().positive().optional(), mode: z.enum(['once', 'bounce']).optional(), blend: z.boolean().optional(), scale: finite().positive().optional() },
    pathParams: { out: 'path' },
    notAPath: { slide: 'deckId/slideId, not a filesystem path' },
    cliArgs: [{ kind: 'pos', at: 0, into: 'elementId', required: true }, { kind: 'flag', at: 'out', into: 'out', required: true },
      { kind: 'flag', at: 'slide', into: 'slide' }, { kind: 'flag', at: 'beat', into: 'beatId' }, { kind: 'flag', at: 'dim', into: 'dim' },
      ...['from', 'to', 'speed', 'fps', 'scale'].map(at => ({ kind: 'flag' as const, at, into: at, as: 'number' as const })),
      { kind: 'flag', at: 'mode', into: 'mode' }, { kind: 'flag', at: 'blend', into: 'blend', as: 'boolean' }],
    handler: async (ctx, a) => {
      const { exportImageMovie } = await import('./fluximgMovie');
      // In the app the movie runs in this CLI as a child of the main process (as a slide video does): progress as
      // FLUX_VIDEO lines on stderr, cancel as any line on stdin (Windows-safe), and the signals.
      const controller = new AbortController(), abort = () => controller.abort();
      const piped = process.env.FLUX_VIDEO_SAVED === '1';
      process.once('SIGTERM', abort); process.once('SIGINT', abort);
      if (piped) { process.stdin.on('data', abort); process.stdin.once('end', abort); }
      try {
        return await exportImageMovie(ctx.root, String(a.elementId), {
          out: String(a.out), ...(typeof a.slide === 'string' ? { slide: a.slide } : {}), ...(typeof a.beatId === 'string' ? { beatId: a.beatId } : {}),
          ...Object.fromEntries(['dim', 'from', 'to', 'speed', 'fps', 'mode', 'blend', 'scale'].filter(k => a[k] !== undefined).map(k => [k, a[k]])),
          signal: controller.signal,
          onProgress: process.env.FLUX_VIDEO_PROGRESS === '1' ? (p) => process.stderr.write(`FLUX_VIDEO ${JSON.stringify(p)}\n`) : undefined,
        });
      } finally {
        process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
        if (piped) { process.stdin.removeListener('data', abort); process.stdin.removeListener('end', abort); process.stdin.pause(); }
      }
    },
    render: {
      human: r => { const m = r as Movie; return { out: JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'stats'))), err: `✓ wrote the movie of image ${m.elementId} → ${m.path}\n${movieWords(m)}${m.warnings.length ? `\n${m.warnings.map(w => `⚠ ${w}`).join('\n')}` : ''}` }; },
      mcp: r => { const m = r as Movie; return text(`wrote ${m.path}\n${movieWords(m)}${m.warnings.length ? `\n${m.warnings.map(w => `⚠ ${w}`).join('\n')}` : ''}\n${JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'stats')))}`); },
    },
  },
  {
    name: 'image_info', cli: 'image-info', cliRoot: 'flags', scope: 'project', readOnly: true,
    summary: 'Describe an N-dimensional image, or how an element shows it, without rendering. Takes an image element id (adds that element\'s box, crop, stored and resolved view, position in words such as "z 12/21 · −50.5 µm", and export size) or a fluximg asset id, and reports dimensions with units and positions, dtype and encoding, levels, channels with default ranges, min/max and percentiles (to choose contrast), layers with object counts and table columns (kind, distinct values, range: what styleBy can use), regions, and every placement. A .tif/.tiff path instead reports how its pages would be read (probe, ranked proposals with the place-image flags for each); nothing is converted.',
    params: { target: z.string() },
    cliArgs: [{ kind: 'pos', at: 0, into: 'target', required: true }],
    handler: (ctx, a) => imageInfo(ctx.root, String(a.target)),
    render: {
      human: r => ({ out: JSON.stringify(r, null, 2) }),
      mcp: r => text(JSON.stringify(r, null, 2)),
    },
  },
];
