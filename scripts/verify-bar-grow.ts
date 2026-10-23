#!/usr/bin/env -S npx tsx
// WP 2.3 (T8 D8a) — keyed bars with no counterpart GROW and SHRINK by transform instead of fading (manim: shapes grow, they do not
// fade). A plot Change `bars5 -> bars10` used to fade bars 5-9 in at 13-40 % opacity over the narrowing bars (12 of 54 frames held a
// translucent bar, lowest 0.13) and the compiler reported a FALSE "no tweenable counterpart and fades" for keyed value-morph bars.
//   • compileSlide reports no issue for the keyed bar Change;
//   • across all frames no bar has an opacity in (0.02, 0.98), and a bar present in one version scales on its own baseline edge
//     (`barGrow`: bottom for a positive vertical bar, top when negative, left for a horizontal one) with a non-decreasing /
//     non-increasing scale, ending clean (every transform property removed at the end it belongs to);
//   • the frame is a pure function of t (forward == reverse == shuffled seeks);
//   • a bar that carries its own `transform` attribute keeps the fade (a CSS transform would replace the attribute);
//   • the pure weight law `barGrowWeight`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML, DOMParser } from "linkedom";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { Slide } from "../src/lib/slide/types";
const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, DOMParser });
const { compileSlide } = await import("../src/lib/slide/compile");
const { createPlayer } = await import("../src/lib/slide/player/player");
const { createDeck } = await import("../src/lib/slide/ops");
const { FLUX_DARK } = await import("../src/lib/slide/theme");
const { cachePlot } = await import("../src/lib/plot/store");
const { barGrowWeight } = await import("../src/lib/slide/growOrigin");
let checks = 0;
const check = (v: unknown, label: string) => { assert.ok(v, label); checks++; console.log("  ok:", label); };
const section = (s: string) => console.log(`\n── ${s} ──`);
const read = (name: string) => ({
  svg: readFileSync(new URL(`./fixtures/plots/${name}.svg`, import.meta.url), "utf8"),
  manifest: JSON.parse(readFileSync(new URL(`./fixtures/plots/${name}.fluxplot.json`, import.meta.url), "utf8")) as FluxPlotManifest,
});

/** A Change `a -> b` over `duration` ms on a linear curve, sampled at `frames` times; returns the compile issues and a sampler of the bars. */
function change(a: { svg: string; manifest: FluxPlotManifest }, b: { svg: string; manifest: FluxPlotManifest }, tag: string, frames = 54, duration = 1080) {
  const manifests: Record<string, FluxPlotManifest> = { [`${tag}A`]: a.manifest, [`${tag}B`]: b.manifest };
  cachePlot(`${tag}A`, a.svg, a.manifest); cachePlot(`${tag}B`, b.svg, b.manifest);
  const slide: Slide = { id: `s-${tag}`, elements: [{ id: "p", type: "plot", assetId: `${tag}A`, x: 0, y: 0, width: 360, height: 260, rotation: 0, source: { svgPath: `plots/${tag}A.svg` } }],
    beats: [{ id: "base", tracks: [] }, { id: "data", tracks: [{ target: "p", preset: "transform", duration, easing: "linear", to: { assetId: `${tag}B`, svgPath: `plots/${tag}B.svg`, manifestPath: `plots/${tag}B.json`, frozen: true } }] }] };
  const options = { theme: FLUX_DARK, reducedMotion: true, plotManifest: (id: string) => manifests[id] };
  const issues = compileSlide(slide, undefined, options).issues;
  const deck = createDeck({ withTitleSlide: false }); deck.slides = [slide]; deck.defaults.transition = "none";
  const host = document.createElement("div") as unknown as HTMLElement;
  const player = createPlayer(host, deck, options);
  const times = Array.from({ length: frames }, (_, i) => Math.round(i * duration / (frames - 1)));
  const barIds = [...new Set([...a.manifest.series, ...b.manifest.series].flatMap(s => s.svg?.bars ?? []))];
  const state = (id: string) => {
    const n = host.querySelector(`[id="p__${id}"]`) as unknown as { style: { getPropertyValue(n: string): string; opacity: string; display: string }; getAttribute(n: string): string | null } | null;
    if (!n) return null;
    const prop = (name: string) => n.style.getPropertyValue(name) ?? ""; // linkedom answers undefined for an absent property
    const scale = /scale[XY]\(([-\d.e]+)\)/.exec(prop("transform"));
    return { opacity: Number(n.style.opacity || n.getAttribute("opacity") || 1), display: n.style.display ?? "", transform: prop("transform"), origin: prop("transform-origin"), box: prop("transform-box"), scale: scale ? Number(scale[1]) : null };
  };
  const at = (ms: number) => { player.seek(0, 1, ms); return Object.fromEntries(barIds.map(id => [id, state(id)])); };
  return { issues, times, barIds, at, host, destroy: () => player.destroy() };
}

section("bars5 -> bars10: nothing fades, bars 5-9 grow from their baseline, bars 0-4 morph in place");
{
  const A = read("mpl_bars_5_FLUXPLOT"), B = read("mpl_bars_10_FLUXPLOT");
  const c = change(A, B, "grow");
  check(!c.issues.some(i => /counterpart|fades/.test(i.reason)), `compileSlide reports no "fades" issue for a keyed bar Change (${c.issues.map(i => i.reason).join("; ") || "no issues"})`);
  const forward = c.times.map(ms => c.at(ms));
  const entering = c.barIds.filter(id => /\.bar\.[5-9]$/.test(id)), paired = c.barIds.filter(id => /\.bar\.[0-4]$/.test(id));
  let translucent = 0;
  for (const frame of forward) if (Object.values(frame).some(s => s && s.opacity > 0.02 && s.opacity < 0.98)) translucent++;
  check(translucent === 0, `no frame holds a translucent bar (${translucent}/${c.times.length}; the fade held 12/54)`);
  for (const id of entering) {
    const scales = forward.map(f => f[id]!.scale);
    check(scales.every((s, i) => i === 0 || s === null || scales[i - 1] === null || s >= scales[i - 1]! - 1e-9), `${id}: the scale never decreases while it grows`);
    check(forward.every(f => f[id]!.scale === null || f[id]!.origin === "50% 100%" && f[id]!.box === "fill-box"), `${id}: it scales about the bottom edge of its own fill box`);
    check(forward.slice(1, -1).some(f => f[id]!.scale !== null && f[id]!.scale! > 0 && f[id]!.scale! < 1), `${id}: it is mid-growth in between`);
    const last = forward[forward.length - 1][id]!;
    check(last.transform === "" && last.origin === "" && last.box === "" && last.display !== "none" && last.opacity === 1, `${id}: ends clean (no transform, origin, box, opacity or display left)`);
    const first = forward[0][id]!;
    check(first.display === "none" || first.scale === 0, `${id}: starts flat on the baseline (or hidden)`);
  }
  for (const id of paired) check(forward.every(f => f[id]!.transform === "" && f[id]!.opacity === 1), `${id}: a bar paired by key morphs in place (no transform, no fade)`);
  // purity: the same t gives the same state, whatever came before
  const reverse = [...c.times].reverse().map(ms => c.at(ms)).reverse();
  const order = c.times.map((_, i) => i).sort((x, y) => ((x * 7919) % 53) - ((y * 7919) % 53));
  const shuffled: ReturnType<typeof c.at>[] = []; for (const i of order) shuffled[i] = c.at(c.times[i]);
  check(JSON.stringify(reverse) === JSON.stringify(forward), "reverse seeks reproduce every forward frame");
  check(JSON.stringify(shuffled) === JSON.stringify(forward), "shuffled seeks reproduce every forward frame");
  c.destroy();
}

section("bars10 -> bars5: bars 5-9 shrink onto their baseline (the mirror), never fade");
{
  const A = read("mpl_bars_10_FLUXPLOT"), B = read("mpl_bars_5_FLUXPLOT");
  const c = change(A, B, "shrink");
  const forward = c.times.map(ms => c.at(ms));
  check(forward.every(f => Object.values(f).every(s => !s || s.opacity <= 0.02 || s.opacity >= 0.98)), "no frame holds a translucent bar");
  for (const id of c.barIds.filter(i => /\.bar\.[5-9]$/.test(i))) {
    const scales = forward.map(f => f[id]!.scale);
    check(scales.every((s, i) => i === 0 || s === null || scales[i - 1] === null || s <= scales[i - 1]! + 1e-9), `${id}: the scale never increases while it shrinks`);
    check(forward[0][id]!.transform === "" && forward[0][id]!.opacity === 1, `${id}: starts as the resting bar (no pop at the start)`);
    check(forward[forward.length - 1][id]!.scale === 0, `${id}: ends flat on its baseline`);
  }
  c.destroy();
}

section("signed and horizontal bars grow from THEIR baseline edge (barGrow)");
for (const [name, origin, fn] of [["bars_mixed_FLUXPLOT", "50% 0%", "scaleY"], ["barh_mixed_FLUXPLOT", "100% 50%", "scaleX"]] as const) {
  const full = read(name);
  const dropped = ["3", "4"]; // bar.3 (+4) and bar.4 (-3.5) exist only in the full version
  const part = structuredClone(full.manifest);
  for (const s of part.series) { s.svg.bars = s.svg.bars!.filter(id => !dropped.some(d => id.endsWith(`.bar.${d}`))); }
  let svg = full.svg;
  for (const s of full.manifest.series) for (const id of s.svg.bars!) if (dropped.some(d => id.endsWith(`.bar.${d}`))) svg = svg.replace(new RegExp(`<g id="${id.replace(/\./g, "\\.")}"[\\s\\S]*?</g>`), "");
  const c = change({ svg, manifest: part }, full, `signed-${name}`);
  const forward = c.times.map(ms => c.at(ms));
  const positive = c.barIds.find(id => id.endsWith(".bar.3"))!, negative = c.barIds.find(id => id.endsWith(".bar.4"))!;
  const origins = (id: string) => new Set(forward.map(f => f[id]!.origin).filter(Boolean));
  const horizontal = name.startsWith("barh");
  check([...origins(negative)].join() === origin, `${name}: the negative bar grows from ${origin}, the far side of its zero line (${[...origins(negative)].join()})`);
  check([...origins(positive)].join() === (horizontal ? "0% 50%" : "50% 100%"), `${name}: the positive bar grows from ${horizontal ? "0% 50%" : "50% 100%"} (${[...origins(positive)].join()})`);
  check(forward.some(f => f[negative]!.transform.startsWith(`${fn}(`)), `${name}: along the value axis (${fn})`);
  c.destroy();
}

section("a bar with its own transform attribute keeps the fade");
{
  const A = read("mpl_bars_5_FLUXPLOT"), B = read("mpl_bars_10_FLUXPLOT");
  const svg = B.svg.replace(/(<[a-z]+ id="count\.bar\.7")/, `$1 transform="translate(0 0)"`);
  check(svg !== B.svg, "the fixture bar carries a transform attribute");
  const c = change(A, { svg, manifest: B.manifest }, "own-transform");
  const forward = c.times.map(ms => c.at(ms));
  const id = c.barIds.find(i => i.endsWith(".bar.7"))!, other = c.barIds.find(i => i.endsWith(".bar.8"))!;
  check(forward.every(f => f[id]!.transform === ""), "its transform is never replaced by a CSS scale");
  check(forward.some(f => f[id]!.opacity > 0.02 && f[id]!.opacity < 0.98), "it fades instead (the old law, never a displaced bar)");
  check(forward.some(f => f[other]!.scale !== null && f[other]!.scale! > 0 && f[other]!.scale! < 1), "while its sibling still grows");
  c.destroy();
}

section("barGrowWeight: one law for growing and shrinking");
check(barGrowWeight(true, 0) === 0 && barGrowWeight(true, .45) === 0 && barGrowWeight(true, 1) === 1, "an entering bar is flat until t = .45 and at rest at t = 1");
check(barGrowWeight(false, 0) === 1 && barGrowWeight(false, .55) === 0 && barGrowWeight(false, 1) === 0, "a leaving bar is at rest at t = 0 and flat from t = .55");
{
  let monotone = true, prev = 0; for (let i = 0; i <= 100; i++) { const w = barGrowWeight(true, i / 100); if (w < prev - 1e-12) monotone = false; prev = w; }
  check(monotone, "the growth is monotone");
  check(Math.abs(barGrowWeight(true, .725) - .5) < 1e-9 && Math.abs(barGrowWeight(false, .275) - .5) < 1e-9, "half-grown at the middle of its window, both ways (smoothstep, calm and symmetric)");
}
console.log(`verify-bar-grow: PASS (${checks} checks)`);
