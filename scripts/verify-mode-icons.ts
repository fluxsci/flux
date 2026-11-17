// The five mode icons in the title bar (2026-11 redesign) are a designed set: one outline and one
// accent palette per mode, neutral structure everywhere else. This gate pins the set as a source
// contract, because nothing else would notice a stray colour, a width that depends on the caller,
// or a copy of a retired icon coming back. Run via run-verifies.
//
//   1. Icon.svelte carries an icon for each mode, and each one uses only its own --icon-* tokens.
//   2. Every drawn element states its stroke width (or has no stroke), so the icon is independent
//      of the `stroke` prop of the component that renders it.
//   3. tokens.css defines the palette; the five accents resolve to five different colours; the
//      Figure icon's pointer is the Flux cursor's default fill and outline (cursorFamily.ts).
//   4. No retired mode icon survives anywhere in the shipped sources or the user docs.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const h = harness("verify-mode-icons");

const MODES = ["figure", "slide", "paper", "library", "reader"] as const;
const OWN: Record<(typeof MODES)[number], string[]> = {
  figure: ["--icon-figure", "--icon-pointer", "--icon-pointer-edge"],
  slide: ["--icon-slide"],
  paper: ["--icon-paper"],
  library: ["--icon-library"],
  reader: ["--icon-reader"],
};

// ---- 1 + 2: the icons themselves -------------------------------------------------------------
h.section("Icon.svelte");
const iconSrc = read("src/shell/Icon.svelte");
const icons: Record<string, string> = {};
for (const m of iconSrc.matchAll(/^ {4}(\w+):\s*\n?\s*'([^'\n]*)',?$/gm)) icons[m[1]] = m[2];
for (const mode of MODES) {
  const markup = icons[mode];
  if (!h.ok(typeof markup === "string" && markup.length > 0, `there is a "${mode}" icon`)) continue;
  const tokens = [...markup.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
  h.ok(tokens.length > 0, `${mode}: has a colour accent`);
  const foreign = [...new Set(tokens.filter((t) => !OWN[mode].includes(t)))];
  h.ok(foreign.length === 0, `${mode}: uses only its own palette (${OWN[mode].join(", ")})${foreign.length ? ` — also found ${foreign.join(", ")}` : ""}`);
  h.ok(!/#[0-9a-fA-F]{3,8}\b/.test(markup), `${mode}: no literal colours, the palette lives in tokens.css`);
  const elements = [...markup.matchAll(/<(path|rect|circle|ellipse|line|polyline|polygon)\b[^>]*>/g)].map((m) => m[0]);
  h.ok(elements.length > 0, `${mode}: draws something`);
  const neutral = elements.filter((e) => !e.includes("var(--icon-"));
  h.ok(neutral.length > 0, `${mode}: has neutral structure beside the accent`);
  const loose = elements.filter((e) => !/stroke-width="/.test(e) && !/stroke="none"/.test(e));
  h.ok(loose.length === 0, `${mode}: every element states its stroke width or has no stroke${loose.length ? ` — ${loose[0]}` : ""}`);
}

// ---- 3: the palette ---------------------------------------------------------------------------
h.section("tokens.css");
const tokensCss = read("src/styles/tokens.css");
const decl = (name: string): string | null => {
  const all = [...tokensCss.matchAll(new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, "gm"))].map((m) => m[1].trim());
  return all.length ? all[0] : null;
};
const resolve = (value: string | null, depth = 0): string | null => {
  if (!value || depth > 4) return value;
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolve(decl(ref[1]), depth + 1) : value.toLowerCase();
};
const colour: Record<string, string | null> = {};
for (const token of Object.values(OWN).flat()) {
  colour[token] = resolve(decl(token));
  h.ok(/^#[0-9a-f]{6}$/.test(colour[token] ?? ""), `${token} resolves to a colour (${colour[token]})`);
}
const accents = MODES.map((mode) => colour[OWN[mode][0]]);
h.eq(new Set(accents).size, MODES.length, `the five mode accents are five different colours (${accents.join(", ")})`);
h.ok(colour["--icon-pointer"] !== colour["--icon-figure"], "Figure's pointer and curve are different colours");

const { CURSOR_DEFAULTS } = await import("../src/lib/cursor/cursorFamily");
h.eq(colour["--icon-pointer"], CURSOR_DEFAULTS.arrowFill.toLowerCase(), "the Figure icon's pointer is the Flux cursor's default fill");
h.eq(colour["--icon-pointer-edge"], CURSOR_DEFAULTS.arrowOutline.toLowerCase(), "…and its default outline");

// ---- 4: nothing retired survives --------------------------------------------------------------
h.section("retired icons");
// A signature fragment of each mode icon this set replaced (2026-07 top-bar rework).
const RETIRED: [string, string][] = [
  ["figure: axes, fit line and three dots", "M4.5 4V19.5H21"],
  ["paper: serif A and caret", 'font-size="16.5" style="font-family: var(--font-serif)'],
  ["slide: stacked frames and play", "M7 4.5h11a2 2 0 0 1 2 2V14"],
  ["library: temple", "M3.5 8.6 12 3.4l8.5 5.2z"],
  ["reader: page with a highlight", "M7.4 13.2h9.2"],
];
const SCAN_DIRS = ["src", "electron", "docs", "resources"];
const SCAN_FILES = ["index.html", "README.md"];
const TEXT = /\.(svelte|ts|js|cjs|mjs|css|html|md|qmd|svg|json)$/;
const walk = (dir: string): string[] =>
  readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name.startsWith("_site") ? [] : walk(path.posix.join(dir, e.name))) : TEXT.test(e.name) ? [path.posix.join(dir, e.name)] : [],
  );
const files = [...SCAN_DIRS.flatMap(walk), ...SCAN_FILES];
h.ok(files.length > 200, `scanned ${files.length} source and docs files`);
const texts = files.map((f) => [f, read(f)] as const);
for (const [what, fragment] of RETIRED) {
  const hits = texts.filter(([, text]) => text.includes(fragment)).map(([f]) => f);
  h.ok(hits.length === 0, `no copy of the retired ${what}${hits.length ? ` — found in ${hits.join(", ")}` : ""}`);
}

await h.done();
