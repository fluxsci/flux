// Hover readouts (colour-system plan F6): what a plot part IS, in data terms, from the manifest
// and the element's own `data-*` attributes — a point's x / y, a bar's height and category, a
// hexagon's count, a cell's value, a box's statistics, a bracket's test and p. One pure text
// builder for the Figure canvas (the deep-hover affordance) and the X-ray tree, so both say the
// same thing. Nothing here reads layout; the DOM contributes only attributes fluxplot wrote.
import { buildPartIndex } from "./parse";
import type { FluxPlotManifest } from "./types";

export interface Readout { title: string; lines: string[] }

const num = (v: unknown, digits = 4): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return a >= 1e5 || a < 1e-3 ? v.toExponential(3) : String(Number(v.toPrecision(digits)));
};
const pValue = (p: unknown): string => typeof p === "number" ? (p < 0.001 ? "p < 0.001" : `p = ${num(p, 3)}`) : "";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

/** The category label an axis gives a data position (a bar's tick), else the number. */
function categoryAt(manifest: FluxPlotManifest | undefined, panelId: string | undefined, axis: "x" | "y", value: unknown): string {
  if (typeof value !== "number") return String(value ?? "—");
  for (const a of manifest?.axes ?? []) {
    const ax = a as unknown as Rec;
    if (panelId && ax.panelId !== panelId) continue;
    const ticks = arr(rec(ax[axis])?.ticks) as { label?: string; value?: number }[] | undefined;
    const hit = ticks?.find((t) => typeof t.value === "number" && Math.abs(t.value - value) < 1e-9 && t.label && !/^-?[\d.]+$/.test(t.label));
    if (hit?.label) return hit.label;
  }
  return num(value);
}

/** "opacity by <source> <value>" when the element carries the scale's alpha channel (B6). */
function alphaLine(manifest: FluxPlotManifest, sRec: Rec | undefined, attrs: Record<string, string | null | undefined>): string[] {
  const raw = attrs["data-alpha-value"];
  if (raw == null || raw === "") return [];
  const scaleId = (rec(sRec?.color)?.scale ?? rec(sRec?.field)?.colorScale) as string | undefined;
  const alpha = rec((manifest.colorScales ?? []).find((sc) => sc.id === scaleId)?.alpha as unknown);
  return [`opacity by ${alpha?.source ?? "value"} ${num(Number(raw))}`];
}

function statsLines(stats: Rec | undefined, keys: [string, string][]): string[] {
  if (!stats) return [];
  return keys.filter(([k]) => stats[k] !== undefined && stats[k] !== null).map(([k, label]) => `${label} ${num(stats[k])}`);
}

/** The readout for a part, or null when there is nothing data-like to say (scaffold). */
export function partReadout(manifest: FluxPlotManifest | undefined, partId: string, attrs: Record<string, string | null | undefined> = {}): Readout | null {
  if (!manifest) return null;
  const index = buildPartIndex(manifest);
  const info = index[partId];
  // the manifest's role, the node's, else fluxplot's id grammar for members of a layer
  const role = info?.role ?? attrs["data-role"] ?? (/\.cell\.\d+\.\d+$/.test(partId) ? "cell" : /\.hex\.\d+\.\d+$/.test(partId) ? "x-hex" : /\.level\.\d+$/.test(partId) ? "contour-level" : "");
  const seriesId = info?.series ?? attrs["data-series"] ?? undefined;
  const series = (manifest.series ?? []).find((s) => s.id === seriesId || (seriesId && (s.svg && Object.values(s.svg).some((v) => v === partId || (Array.isArray(v) && v.includes(partId))))))
    ?? (manifest.series ?? []).find((s) => Object.values(s.svg ?? {}).some((v) => v === partId || (Array.isArray(v) && v.includes(partId))) || (s.points ?? []).some((p) => p.svgId === partId) || (s.components ?? []).some((c) => c.svgId === partId || c.members?.includes(partId)));
  const owner = series ?? (manifest.series ?? []).find((s) => partId.startsWith(s.id + "."));
  const sRec = owner as unknown as Rec | undefined;
  const label = (owner?.label ?? owner?.name ?? owner?.id ?? "") as string;
  const lines: string[] = [];

  // the element's own value (a heatmap cell, a contour band, any colour-mapped element)
  const dataValue = attrs["data-value"];
  const missing = attrs["data-missing"] === "1";

  switch (role) {
    case "point": {
      const pt = owner?.points?.find((p) => p.svgId === partId);
      const i = pt?.index ?? info?.index;
      const data = rec(sRec?.data);
      const x = pt?.x ?? (i !== undefined ? arr(data?.x)?.[i] : undefined), y = pt?.y ?? (i !== undefined ? arr(data?.y)?.[i] : undefined);
      lines.push(`x = ${num(x)}, y = ${num(y)}`);
      const c = i !== undefined ? arr(data?.c)?.[i] : undefined;
      if (c !== undefined) lines.push(`value ${num(c)}`);
      if (dataValue != null) lines.push(`value ${missing ? "missing" : num(Number(dataValue))}`);
      lines.push(...alphaLine(manifest, sRec, attrs));
      return { title: `${label} · point ${i ?? ""}`.trim(), lines };
    }
    case "bar": {
      const bars = arr(sRec?.svg && (sRec.svg as Rec).bars);
      const i = info?.index ?? (bars ? bars.indexOf(partId) : -1);
      const bar = rec(sRec?.bar), data = rec(sRec?.data);
      const vertical = bar?.orientation !== "horizontal";
      const length = i >= 0 ? arr(bar?.length)?.[i] : undefined, base = i >= 0 ? arr(bar?.baseline)?.[i] : undefined;
      const pos = i >= 0 ? arr(data?.[vertical ? "x" : "y"])?.[i] : undefined;
      if (pos !== undefined) lines.push(`${vertical ? "x" : "y"} = ${categoryAt(manifest, owner?.panelId as string | undefined, vertical ? "x" : "y", pos)}`);
      if (length !== undefined) lines.push(`${vertical ? "height" : "length"} ${num(length)}${typeof base === "number" && base !== 0 ? ` from ${num(base)}` : ""}`);
      return { title: `${label} · bar ${i >= 0 ? i : ""}`.trim(), lines };
    }
    case "x-hex": {
      const bins = arr(rec(sRec?.hexmatrix)?.bins) as Rec[] | undefined;
      const bin = bins?.find((b) => b.svgId === partId);
      if (bin) {
        lines.push(`x = ${num(bin.x)}, y = ${num(bin.y)}`);
        if (bin.count !== undefined) lines.push(`count ${num(bin.count)}`);
        if (bin.value !== undefined && bin.value !== bin.count) lines.push(`${(rec(sRec?.hexmatrix)?.valueLabel as string) || "value"} ${num(bin.value)}`);
      } else if (dataValue != null) lines.push(`value ${missing ? "missing" : num(Number(dataValue))}`);
      lines.push(...alphaLine(manifest, sRec, attrs));
      return { title: `${label} · hexagon${bin ? ` ${bin.row},${bin.col}` : ""}`, lines };
    }
    case "cell": {
      const m = /\.cell\.(\d+)\.(\d+)$/.exec(partId);
      const field = rec(sRec?.field);
      let value: unknown = dataValue != null ? (missing ? null : Number(dataValue)) : undefined;
      if (value === undefined && m && field) value = arr(arr(field.values)?.[Number(m[1])])?.[Number(m[2])];
      lines.push(`value ${value === null ? "missing" : num(value)}`);
      if (m) lines.push(`row ${m[1]}, column ${m[2]}`);
      lines.push(...alphaLine(manifest, sRec, attrs));
      return { title: `${label} · cell`, lines };
    }
    case "contour-level": {
      const lo = attrs["data-level-low"], hi = attrs["data-level-high"];
      if (lo != null && hi != null) lines.push(`band ${lo} … ${hi}`);
      else if (dataValue != null) lines.push(`level ${num(Number(dataValue))}`);
      return { title: `${label} · contour`, lines };
    }
    case "significance-bracket": {
      const ov = (manifest.overlays ?? []).find((o) => o.svgId === partId || o.id === partId) as unknown as Rec | undefined;
      const stats = rec(ov?.stats);
      const between = arr(ov?.between);
      const title = between ? `${between.join(" vs ")}` : "Significance bracket";
      if (stats?.test) lines.push(String(stats.test));
      const p = stats?.pCorrected ?? stats?.p ?? ov?.p;
      if (p !== undefined) lines.push(`${pValue(p)}${stats?.correction && stats.correction !== "none" ? ` (${stats.correction})` : ""}`);
      if (stats?.effectSize !== undefined) lines.push(`${stats.effectSizeMethod ?? "effect"} ${num(stats.effectSize)}${stats.ciLow !== undefined ? ` [${num(stats.ciLow)}, ${num(stats.ciHigh)}]` : ""}`);
      if (stats?.n !== undefined) lines.push(`n = ${Array.isArray(stats.n) ? stats.n.join(" / ") : num(stats.n)}`);
      if (!lines.length && ov?.label) lines.push(String(ov.label));
      return { title, lines };
    }
    case "annotation": case "reference-line": case "scalebar": {
      const ov = (manifest.overlays ?? []).find((o) => o.svgId === partId || o.id === partId) as unknown as Rec | undefined;
      if (!ov) return null;
      if (ov.text) lines.push(String(ov.text));
      if (ov.length !== undefined) lines.push(`${num(ov.length)} ${ov.units ?? ""}`.trim());
      return { title: String(info?.label ?? role), lines };
    }
    case "legend-swatch": case "legend-label": case "legend-entry": {
      for (const g of manifest.guides ?? []) {
        for (const e of ((g as unknown as Rec).entries as Rec[] | undefined) ?? []) {
          if (e.swatch === partId || e.label === partId || e.svgId === partId) {
            const s = (manifest.series ?? []).find((x) => x.id === e.series);
            return { title: `Legend · ${e.text ?? s?.label ?? e.series ?? ""}`, lines: s ? [`series ${s.id}${s.kind ? ` (${s.kind})` : ""}`] : [] };
          }
        }
      }
      return null;
    }
    default:
      break;
  }
  if (!owner) {
    // a colorbar: the scale it draws
    const guide = (manifest.guides ?? []).find((g) => g.svgId === partId || g.id === partId || (g.parts ?? []).some((p) => p.svgId === partId)) as unknown as Rec | undefined;
    if (guide?.role === "colorbar") {
      const scale = (manifest.colorScales ?? []).find((sc) => sc.id === guide.colorScale);
      if (scale) return { title: `Colour scale · ${scale.label ?? scale.id}`, lines: [`${scale.colormap.name}, ${scale.norm.kind} ${num(scale.norm.vmin)} … ${num(scale.norm.vmax)}`] };
    }
    return null;
  }
  // series-level parts: what the series is, with its summary statistics when fluxplot recorded them
  const stats = rec(rec(sRec?.glowbar)?.stats) ?? rec(rec(sRec?.fluxbox)?.stats) ?? rec(sRec?.distribution);
  const data = rec(sRec?.data);
  const xs = arr(data?.x), ys = arr(data?.y);
  if (xs && ys) {
    const finite = ys.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    lines.push(`${xs.length} points${finite.length ? `, y ${num(Math.min(...finite))} … ${num(Math.max(...finite))}` : ""}`);
  }
  lines.push(...statsLines(stats, [["n", "n"], ["mean", "mean"], ["median", "median"], ["sd", "sd"], ["sem", "sem"], ["q1", "q1"], ["q3", "q3"], ["whiskerLow", "whisker low"], ["whiskerHigh", "whisker high"]]));
  const band = rec(sRec?.band);
  if (band?.what) lines.push(`band: ${band.what}`);
  const image = rec(sRec?.image);
  if (image) lines.push(`image ${(arr(image.shape) ?? []).join("×")}${arr(image.channels) ? `, ${(arr(image.channels) as Rec[]).map((c) => c.name).join(" + ")}` : ""}`);
  // fitted curves, steps and stems say what they are (fluxplot 0.3.2 payloads)
  const fit = rec(sRec?.regression);
  if (fit) {
    const coef = arr(fit.coefficients);
    lines.push(`${fit.kind === "lowess" ? `lowess (span ${num(fit.frac)})` : fit.kind === "poly" ? `polynomial, degree ${fit.degree}` : "linear fit"}${coef && fit.kind === "linear" ? `: slope ${num(coef[0])}, intercept ${num(coef[1])}` : ""}`);
    const r2 = fit.r2 !== undefined ? `R² ${num(fit.r2, 3)}` : "";
    const p = pValue(fit.p);
    if (r2 || p) lines.push([r2, p].filter(Boolean).join(", "));
    if (fit.n !== undefined) lines.push(`n = ${num(fit.n)}${fit.ci !== undefined ? `, ${Math.round(Number(fit.ci) * 100)}% band` : ""}`);
  }
  const kde = rec(sRec?.kde);
  if (kde) lines.push(`density estimate, bandwidth ${num(kde.bandwidth, 3)}, n = ${num(kde.n)}`);
  const step = rec(sRec?.step);
  if (step) lines.push(`step (${step.where})`);
  const stem = rec(sRec?.stem);
  if (stem) lines.push(`stems from ${num(stem.baseline)}`);
  if (sRec?.axis) lines.push(`on the ${sRec.axis === "y2" ? "right (y2)" : "top (x2)"} axis`);
  if (dataValue != null) lines.push(`value ${missing ? "missing" : num(Number(dataValue))}`);
  const col = rec(sRec?.color);
  if (col?.hex && col.hex !== "varies") lines.push(`colour ${col.hex}${col.token ? ` (${col.token})` : ""}`);
  return { title: `${label}${owner.kind ? ` · ${owner.kind}` : ""}`, lines };
}

/** The readout as one tooltip string (title, then each line). */
export function readoutText(r: Readout | null): string {
  if (!r) return "";
  return [r.title, ...r.lines].filter(Boolean).join("\n");
}

/** The `data-*` attributes fluxplot wrote on a live node, for `partReadout`. */
export function nodeAttrs(node: { getAttribute(n: string): string | null; querySelector?(s: string): { getAttribute(n: string): string | null } | null } | null | undefined): Record<string, string | null> {
  if (!node) return {};
  const out: Record<string, string | null> = {};
  for (const a of ["data-role", "data-series", "data-value", "data-missing", "data-level-low", "data-level-high", "data-index", "data-alpha-value", "data-key"]) {
    out[a] = node.getAttribute(a) ?? node.querySelector?.(`[${a}]`)?.getAttribute(a) ?? null;
  }
  return out;
}
