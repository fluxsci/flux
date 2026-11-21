// The W7 export gates' fixture (verify-fluximg-slide-export*.ts): an isolated project with a SYNTHETIC image (t, c, y, x
// uint16, a styled label layer, a vector layer, an intensity layer) written by the TS writer into plots/ and placed on a
// slide by the real place-image verb (the bundle lands in fig/assets/<id>.fluximg, the figure index untouched). Nothing
// private: every value is generated here.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
export async function makeProject(opts: { T?: number; H?: number; W?: number; C?: number } = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "fx-slide-export-"));
  const { isolatedEnv } = await import("./verifyRuntime.mjs");
  Object.assign(process.env, isolatedEnv(path.join(scratch, "machine")), { FLUX_NO_MIGRATE: "1" });
  const core = await import("../../flux-core/index");
  const slidesCore = await import("../../flux-core/slides");
  const { VERBS } = await import("../../flux-core/registry");
  const { writeFluximg, arraySource } = await import("../../src/lib/fluximg/writer");
  const { nodeBundleWriter, nodeZstd } = await import("../../flux-core/fluximgIo");
  const root = path.join(scratch, "project");
  await core.scaffold(root, { title: "image export" });
  const T = opts.T ?? 24, C = opts.C ?? 2, H = opts.H ?? 48, W = opts.W ?? 64;
  const data = new Uint16Array(T * C * H * W);
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    data[((t * C + c) * H + y) * W + x] = 50 + ((x * (c + 1) * 13 + y * 7 + t * 97 + c * 500) % 4000);
  const labels = new Uint16Array(H * W);
  const blob = (l: number, y0: number, x0: number, hh: number, ww: number) => { for (let y = y0; y < Math.min(H, y0 + hh); y++) for (let x = x0; x < Math.min(W, x0 + ww); x++) labels[y * W + x] = l; };
  blob(1, 4, 6, 6, 8); blob(2, 20, 30, 8, 6); blob(3, 34, 44, 5, 12); blob(4, 10, 50, 7, 7);
  const glow = new Uint16Array(H * W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) glow[y * W + x] = (x * 17 + y * 29) % 1000;
  await fs.mkdir(path.join(root, "plots"), { recursive: true });
  await writeFluximg(nodeBundleWriter(path.join(root, "plots", "movie.fluximg")), await nodeZstd(), {
    name: "movie", source: arraySource(data, ["t", "c", "y", "x"], [T, C, H, W], "uint16"),
    axes: { t: { unit: "s", scale: 0.1 }, y: { unit: "µm", scale: 0.5 }, x: { unit: "µm", scale: 0.5 } },
    channels: [{ name: "a", color: "#ff00ff", range: [100, 3000] }, { name: "b", color: "#00ff00", range: [100, 3500] }],
    layers: [
      { kind: "labels", id: "cells", name: "cells", data: labels, visible: true, key: "label", table: { key: "label", columns: { label: [1, 2, 3, 4], kind: ["x", "y", "x", "z"] } } },
      { kind: "vector", id: "marks", name: "marks", count: 2, body: '<circle id="marks/p" data-key="p" cx="12.5" cy="30.5" r="3"/><line id="marks/q" data-key="q" x1="40" y1="5" x2="60" y2="20"/>', visible: true },
      { kind: "intensity", id: "glow", name: "glow", data: glow, dtype: "uint16", color: "#ffd400", range: [0, 1000], opacity: 0.6, visible: false },
    ],
  } as never);
  const call = async (name: string, args: Record<string, unknown>) => { const v = VERBS.find((x) => x.name === name)!; return v.handler({ root, transport: "mcp" } as never, z.object(v.params).parse(args) as never) as Promise<any>; };
  await core.createDeck(root, { id: "talk", title: "Talk" });
  const slideId = (await slidesCore.loadDeck(root, "talk")).slides[0].id;
  const placed = await call("place_image", { figureId: `talk/${slideId}`, bundlePath: "plots/movie.fluximg", name: "Movie", x: 40, y: 20, width: 320, height: 240 });
  return { scratch, root, core, slidesCore, call, slideId, placed, dims: { T, C, H, W } };
}

/** The views of the standard deck: Design at t 0, then one Change per thing an image can do. */
export const CELLS = { visible: true, styleBy: { color: { column: "kind" } } };
const base = { layers: { cells: CELLS, marks: { visible: true } }, furniture: { stamp: {}, scalebar: {} } };
export const view = (patch: Record<string, unknown>) => structuredClone({ ...base, ...patch });
export const V0 = view({ index: { t: 0 } });
export const V1 = view({ index: { t: 20 } });                                                                                  // walk 20 planes
export const V2 = view({ index: { t: 20 }, channels: [{ range: [600, 2200] }, { range: [300, 1800], gamma: 1.6, norm: "gamma" }] }); // contrast
export const CROP3 = { x: 16, y: 12, width: 32, height: 24 };                                                                   // zoom in
export const V4 = view({ index: { t: 20 }, channels: [{ range: [600, 2200] }, { range: [300, 1800], gamma: 1.6, norm: "gamma" }],
  layers: { cells: { ...CELLS, opacity: 0.25 }, marks: { visible: false } } });                                                  // layer fades (overlay only)
export const V5 = view({ index: { t: 4 }, channels: [{ range: [600, 2200] }, { range: [300, 1800], gamma: 1.6, norm: "gamma" }],
  layers: { cells: { ...CELLS, opacity: 0.25 }, marks: { visible: false } } });                                                  // walk back, blended

/** Write the standard deck: beats b1 walk (1 s linear), b2 contrast, b3 zoom, b4 layer fade, b5 blended walk back. */
export async function standardDeck(P: Awaited<ReturnType<typeof makeProject>>, durations: Partial<Record<string, number>> = {}) {
  await P.slidesCore.mutateDeck(P.root, "talk", "fixture", (deck: any) => {
    deck.defaults.transition = "none";
    const s = deck.slides[0], el = s.elements.find((e: any) => e.type === "fluximg");
    el.view = V0; el.x = 40; el.y = 20; el.width = 320; el.height = 240; delete el.crop;
    const tr = (id: string, state: any, extra: any = {}) => ({ id, target: el.id, preset: "transform", start: 0, duration: durations[id] ?? 1000, easing: "linear", to: { state }, ...extra });
    s.beats = [s.beats[0],
      { id: "b1", tracks: [tr("walk", { view: V1 })] },
      { id: "b2", tracks: [tr("contrast", { view: V2 })] },
      { id: "b3", tracks: [tr("zoom", { crop: CROP3 })] },
      { id: "b4", tracks: [tr("fade", { view: V4 })] },
      { id: "b5", tracks: [tr("blend", { view: V5 }, { params: { blend: true } })] },
    ];
  });
  return (await P.slidesCore.loadDeck(P.root, "talk"));
}
