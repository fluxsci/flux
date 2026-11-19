/**
 * Check a bundle against fluximg/1: the manifest, every array's metadata, the cross-references between
 * them, and (unless `quick`) every stored chunk. Pure; the same check backs the CLI, the import path and the
 * conformance tests of other writers.
 */
import { CORE_DIMS, DTYPE_BYTES, FLUXIMG_MANIFEST, PERCENTILE_KEYS, type FluximgManifest, type FluximgStats } from "./types";
import { FluximgFormatError, chunksPerShard, ndindex, product, shardCounts, shardIndexBytes, shardKey, decodeShardIndex } from "./zarr";
import { openFluximg, type ArrayHandle, type BundleReadIO, type FluximgReader, type ZstdCodec } from "./reader";

export interface ValidationIssue { code: string; message: string; path?: string }
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  manifest: FluximgManifest | null;
  /** Chunks decoded and shards visited. */
  chunks: number;
  shards: number;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const SVG_FORBIDDEN: Array<[RegExp, string]> = [
  [/<script/i, "script"], [/<style/i, "style"], [/<image/i, "image"], [/<foreignObject/i, "foreignObject"], [/<use/i, "use"],
  [/\son[a-z]+\s*=/i, "event handler"], [/(?:xlink:)?href\s*=/i, "href"], [/url\(/i, "url()"], [/<!ENTITY/i, "entity"],
];
const SHAPE_RE = /<(path|polyline|polygon|line|circle|ellipse|rect)\b([^>]*)>/g;
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
};

export async function validateFluximg(io: BundleReadIO, codec: ZstdCodec, options: { quick?: boolean } = {}): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const bad = (code: string, message: string, path?: string): void => { issues.push({ code, message, ...(path ? { path } : {}) }); };
  let reader: FluximgReader;
  try { reader = await openFluximg(io, codec, { verifyIndex: true }); } catch (e) {
    bad("manifest", (e as Error).message, FLUXIMG_MANIFEST);
    return { ok: false, issues, manifest: null, chunks: 0, shards: 0 };
  }
  const m = reader.manifest, p = m.pixels;
  let chunks = 0, shards = 0;
  const int = (v: unknown): v is number => Number.isInteger(v);
  const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  // ---- dimensions --------------------------------------------------------------------------------
  const dims = p.dims, nd = dims.length;
  const core = CORE_DIMS as readonly string[];
  if (new Set(dims).size !== nd) bad("dims", "dimension names repeat");
  if (!dims.every((d) => NAME_RE.test(d))) bad("dims", "dimension names must be lower-case identifiers");
  const canonical = [...dims.filter((d) => !core.includes(d)), ...core.filter((d) => dims.includes(d))];
  if (JSON.stringify(canonical) !== JSON.stringify(dims)) bad("dims", `dimensions must be ordered ${JSON.stringify(canonical)}`);
  if (dims[nd - 2] !== "y" || dims[nd - 1] !== "x") bad("dims", "the last two dimensions must be y and x");
  if (!p.shape.every((s) => int(s) && s > 0)) bad("shape", "pixels.shape must be positive integers");
  const H = p.shape[nd - 2], W = p.shape[nd - 1];
  const ci = dims.indexOf("c"), C = ci >= 0 ? p.shape[ci] : 1;
  if (p.path !== "pixels") bad("pixels", 'pixels.path must be "pixels"');
  if (p.ome !== dims.every((d) => core.includes(d))) bad("ome", "pixels.ome must be true exactly when every dimension is one of t, c, z, y, x");

  // ---- encoding ----------------------------------------------------------------------------------
  const enc = p.encoding;
  if (!enc || (enc.kind !== "exact" && enc.kind !== "linear16")) bad("encoding", "pixels.encoding.kind must be exact or linear16");
  else if (enc.kind === "linear16") {
    if (p.dtype !== "uint16") bad("encoding", "linear16 pixels must be stored as uint16");
    if (!Array.isArray(enc.channels) || enc.channels.length !== C) bad("encoding", `linear16 needs one scale/offset per channel (${C})`);
    else if (!enc.channels.every((c) => fin(c.scale) && c.scale > 0 && fin(c.offset))) bad("encoding", "linear16 scale must be positive and finite");
    if (enc.nodataCode !== 0) bad("encoding", "linear16 nodataCode must be 0");
  }
  if (!(p.dtype in DTYPE_BYTES)) bad("dtype", `unsupported dtype ${p.dtype}`);

  // ---- levels and their arrays -----------------------------------------------------------------
  const visit = async (a: ArrayHandle, what: string): Promise<void> => {
    const per = product(chunksPerShard(a.meta));
    for (const sc of ndindex(shardCounts(a.meta.shape, a.meta.outer))) {
      const file = `${a.path}/${shardKey(sc)}`;
      if (io.exists && !(await io.exists(file))) continue;            // never written: all fill
      shards++;
      let index;
      try { index = decodeShardIndex(await io.readRange(file, -shardIndexBytes(per), shardIndexBytes(per)), per, true, file); }
      catch (e) { bad("shard", (e as Error).message, file); continue; }
      if (options.quick) continue;
      const cps = chunksPerShard(a.meta);
      let local = 0;
      for (const lc of ndindex(cps)) {
        const k = local++;
        if (index.offsets[k] < 0) continue;
        const coords = lc.map((v, i) => sc[i] * cps[i] + v);
        if (coords.some((v, i) => v >= a.counts[i])) { bad("shard", "a chunk outside the array is stored", file); continue; }
        try { await reader.readChunk(a, coords); chunks++; } catch (e) { bad("chunk", (e as Error).message, `${what} ${JSON.stringify(coords)}`); }
      }
    }
  };
  if (!p.levels.length || p.levels[0].downsample !== 1) bad("levels", "the first level must have downsample 1");
  let prev = 0;
  for (let i = 0; i < p.levels.length; i++) {
    const lv = p.levels[i];
    if (!(int(lv.downsample) && lv.downsample > prev)) bad("levels", "downsample factors must be increasing integers");
    prev = lv.downsample;
    const want = [...p.shape.slice(0, nd - 2), Math.ceil(H / lv.downsample), Math.ceil(W / lv.downsample)];
    if (JSON.stringify(lv.shape) !== JSON.stringify(want)) bad("levels", `level ${lv.path} must have shape ${JSON.stringify(want)}`);
    try {
      const a = await reader.level(i);
      if (JSON.stringify(a.meta.shape) !== JSON.stringify(lv.shape)) bad("levels", `level ${lv.path}: zarr shape differs from the manifest`, a.path);
      if (a.meta.dtype !== p.dtype) bad("levels", `level ${lv.path}: zarr data_type ${a.meta.dtype} differs from pixels.dtype ${p.dtype}`, a.path);
      if (JSON.stringify(a.meta.dims) !== JSON.stringify(dims)) bad("levels", `level ${lv.path}: dimension_names differ from pixels.dims`, a.path);
      if (!a.meta.inner.slice(0, nd - 2).every((v) => v === 1)) bad("levels", `level ${lv.path}: an inner chunk must hold one plane or one tile of a plane`, a.path);
      await visit(a, `level ${lv.path}`);
    } catch (e) { bad("levels", (e as Error).message, `${p.path}/${lv.path}`); }
  }
  try {
    const g = JSON.parse(await io.readText(`${p.path}/zarr.json`));
    const ome = g?.attributes?.ome;
    if (g?.zarr_format !== 3 || g?.node_type !== "group") bad("group", "pixels/zarr.json must be a Zarr v3 group");
    if (p.ome) {
      if (ome?.version !== "0.5") bad("ome", "OME-Zarr metadata must be version 0.5");
      const names = ome?.multiscales?.[0]?.axes?.map((x: any) => x.name);
      if (JSON.stringify(names) !== JSON.stringify(dims)) bad("ome", "OME axes must match pixels.dims");
      if ((ome?.multiscales?.[0]?.datasets?.length ?? 0) !== p.levels.length) bad("ome", "OME datasets must list every level");
    } else if (ome) bad("ome", "a bundle with extra dimensions must not claim OME-Zarr metadata");
  } catch (e) { bad("group", (e as Error).message, `${p.path}/zarr.json`); }

  // ---- channels, axes, profiles, defaults --------------------------------------------------------
  const statsOk = (st: FluximgStats | undefined, where: string): void => {
    if (!st || !int(st.count) || !st.hist || !Array.isArray(st.hist.counts) || st.hist.counts.length !== 256) { bad("stats", "stats need count and a 256-bin histogram", where); return; }
    if (st.count === 0) return;
    if (!PERCENTILE_KEYS.every((k) => fin(st.percentiles?.[k]))) { bad("stats", `stats.percentiles needs ${PERCENTILE_KEYS.join(", ")}`, where); return; }
    const seq = [st.min, ...PERCENTILE_KEYS.map((k) => st.percentiles[k]), st.max];
    if (!seq.every(fin) || seq.some((v, i) => i > 0 && v < seq[i - 1])) bad("stats", "min, percentiles and max must be finite and non-decreasing", where);
    if (!(st.hist.hi > st.hist.lo)) bad("stats", "hist.hi must exceed hist.lo", where);
  };
  if (m.channels.length !== C) bad("channels", `expected ${C} channel(s), found ${m.channels.length}`);
  m.channels.forEach((c, i) => {
    if (typeof c.name !== "string" || !c.name) bad("channels", `channel ${i} needs a name`);
    if (!!c.color === !!c.lut) bad("channels", `channel ${i} needs exactly one of color and lut`);
    if (c.color && !/^#[0-9a-fA-F]{6}$/.test(c.color)) bad("channels", `channel ${i}: color must be #rrggbb`);
    if (!Array.isArray(c.range) || !fin(c.range[0]) || !fin(c.range[1]) || !(c.range[1] > c.range[0])) bad("channels", `channel ${i}: range must be [low, high] with high > low`);
    statsOk(c.stats, `channel ${i}`);
  });
  for (const d of dims) {
    if (d === "c") { if (m.axes.c) bad("axes", "the channel dimension has no axis entry"); continue; }
    const a = m.axes[d];
    if (!a) { bad("axes", `axis ${d} is missing`); continue; }
    const n = p.shape[dims.indexOf(d)];
    if (a.coords) {
      if (d === "x" || d === "y") bad("axes", `axis ${d} must be evenly spaced`);
      if (!Array.isArray(a.coords) || a.coords.length !== n || !a.coords.every(fin)) bad("axes", `axis ${d}: coords must be ${n} finite numbers`);
    } else if (!fin(a.scale) || a.scale === 0 || !fin(a.offset ?? 0)) bad("axes", `axis ${d}: scale must be a non-zero number`);
    if (a.labels && (!Array.isArray(a.labels) || a.labels.length !== n)) bad("axes", `axis ${d}: labels must have ${n} entries`);
  }
  const profDims = dims.slice(0, nd - 2).filter((d) => d !== "c");
  for (const d of profDims) {
    const pr = m.profiles?.[d];
    const n = p.shape[dims.indexOf(d)];
    if (!pr || !Array.isArray(pr.mean) || pr.mean.length !== C || !pr.mean.every((r) => Array.isArray(r) && r.length === n)) bad("profiles", `profiles.${d}.mean must be ${C} list(s) of ${n} values`);
  }
  for (const [d, i] of Object.entries(m.defaults?.index ?? {})) {
    const k = dims.indexOf(d);
    if (k < 0 || k >= nd - 2 || d === "c" || !int(i) || i < 0 || i >= p.shape[k]) bad("defaults", `defaults.index.${d} is out of range`);
  }
  const rids = new Set<string>();
  for (const r of m.regions) {
    if (!NAME_RE.test(r.id) || rids.has(r.id)) bad("regions", `region id ${JSON.stringify(r.id)} must be a unique lower-case identifier`);
    rids.add(r.id);
    const q = r.rect;
    if (!q || ![q.x, q.y, q.width, q.height].every(fin) || q.width <= 0 || q.height <= 0 || q.x < 0 || q.y < 0 || q.x + q.width > W || q.y + q.height > H) bad("regions", `region ${r.id}: rect must lie inside the image`);
  }

  // ---- layers ------------------------------------------------------------------------------------
  const lids = new Set<string>();
  const svgOf = async (path: string): Promise<string | null> => {
    let text: string;
    try { text = await io.readText(path); } catch { bad("layers", "file is missing", path); return null; }
    for (const [re, what] of SVG_FORBIDDEN) if (re.test(text)) bad("svg", `${what} is not allowed in a layer`, path);
    const vb = /<svg[^>]*\sviewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(text);
    if (!vb || Number(vb[1]) !== W || Number(vb[2]) !== H) bad("svg", `viewBox must be "0 0 ${W} ${H}"`, path);
    return text;
  };
  for (const L of m.layers) {
    if (!NAME_RE.test(L.id) || lids.has(L.id)) bad("layers", `layer id ${JSON.stringify(L.id)} must be a unique lower-case identifier`);
    lids.add(L.id);
    if (L.kind === "intensity" || L.kind === "labels") {
      try {
        const a = await reader.array(L.path);
        if (JSON.stringify(a.meta.shape) !== JSON.stringify([H, W]) || JSON.stringify(a.meta.dims) !== JSON.stringify(["y", "x"])) bad("layers", `layer ${L.id} must be a (y, x) array of ${H} x ${W}`, L.path);
        if (a.meta.dtype !== L.dtype) bad("layers", `layer ${L.id}: dtype differs from its array`, L.path);
        await visit(a, `layer ${L.id}`);
      } catch (e) { bad("layers", (e as Error).message, L.path); }
    }
    if (L.kind === "intensity") {
      if (!!L.color === !!L.lut) bad("layers", `layer ${L.id} needs exactly one of color and lut`);
      if (!Array.isArray(L.range) || !(L.range[1] > L.range[0])) bad("layers", `layer ${L.id}: range must be [low, high]`);
      if (L.encoding?.kind === "linear16" && (L.dtype !== "uint16" || L.encoding.channels?.length !== 1)) bad("layers", `layer ${L.id}: linear16 needs uint16 and one scale/offset`);
      if (L.opacity !== undefined && L.opacity !== "value" && !(fin(L.opacity) && L.opacity >= 0 && L.opacity <= 1)) bad("layers", `layer ${L.id}: opacity must be 0..1 or "value"`);
      statsOk(L.stats, `layer ${L.id}`);
    } else {
      let table = null as Awaited<ReturnType<FluximgReader["readTable"]>> | null;
      const tablePath = L.kind === "labels" ? L.table : L.table ?? null;
      if (tablePath) {
        try {
          table = await reader.readTable(tablePath);
          const lens = Object.values(table.columns).map((c) => c.length);
          if (lens.some((n) => n !== lens[0])) bad("table", "columns must have equal lengths", tablePath);
          if (!table.columns[L.key ?? table.key]) bad("table", `key column ${JSON.stringify(L.key ?? table.key)} is missing`, tablePath);
        } catch (e) { bad("table", (e as Error).message, tablePath); }
      }
      const svgPath = L.kind === "labels" ? L.outlines : L.path;
      const text = await svgOf(svgPath);
      if (text) {
        const shapes = [...text.matchAll(SHAPE_RE)].map((s) => s[0]);
        const keys = shapes.map((s) => attr(s, "data-key"));
        if (keys.some((k) => k === null)) bad("svg", "every shape needs a data-key", svgPath);
        if (new Set(keys).size !== keys.length) bad("svg", "data-key values must be unique", svgPath);
        if (shapes.length !== L.count) bad("layers", `layer ${L.id}: count is ${L.count} but the SVG has ${shapes.length} shapes`, svgPath);
        if (!new RegExp(`<g[^>]*\\sid="${L.id}"`).test(text)) bad("svg", `the shapes must sit in <g id="${L.id}">`, svgPath);
        if (table) {
          const col = new Set((table.columns[L.key ?? table.key] ?? []).map(String));
          if (keys.some((k) => k !== null && !col.has(k))) bad("layers", `layer ${L.id}: a shape's data-key has no table row`, svgPath);
        }
        if (L.kind === "labels") {
          if (!table?.columns.label) bad("table", 'a labels table needs an integer "label" column', L.table);
          else {
            const keyCol = table.columns[L.key ?? table.key] ?? [];
            const want = new Map(table.columns.label.map((l, i) => [String(l), String(keyCol[i])]));
            for (const s of shapes) {
              const l = attr(s, "data-label");
              if (l === null || want.get(l) !== attr(s, "data-key")) { bad("layers", `layer ${L.id}: outline data-label / data-key do not match the table`, svgPath); break; }
            }
          }
          if (L.weights && !m.layers.some((x) => x.kind === "intensity" && x.id === L.weights)) bad("layers", `layer ${L.id}: weights layer ${L.weights} does not exist`);
        }
      }
    }
  }
  return { ok: issues.length === 0, issues, manifest: m, chunks, shards };
}

export { FluximgFormatError };
