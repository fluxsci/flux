// P6 hygiene gate — every CSS custom property referenced via var(--…) in src/ must be DEFINED
// somewhere (tokens.css, a component-local declaration, or set at runtime via style.setProperty).
// Undefined tokens silently fall back to `inherit`/nothing, which is how --c-tx-1/-3, --c-de, etc.
// drifted in. Run: node scripts/verify-tokens.mjs  (wire into CI next to npm run check).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const SRC = join(root, "src");

// The design-token namespace — names owned by tokens.css. Only these are ENFORCED: a reference to
// one that tokens.css never defines is drift (a typo or a removed token). Everything else
// (component-local props, runtime-injected slide-theme --sl-*, layout --gutter-*/--film-w, …) is
// legitimately defined outside tokens.css and out of scope for this gate.
const TOKEN_PREFIXES = [
  "--c-", "--ts-", "--sp-", "--r-", "--dur-", "--ease-",
  "--lh-", "--tracking-", "--elev-", "--font-", "--titlebar-",
];
const isToken = (n) => TOKEN_PREFIXES.some((p) => n.startsWith(p));

/** Recursively collect files with the given extensions. */
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, exts, out);
    else if (exts.includes(extname(p))) out.push(p);
  }
  return out;
}

const files = walk(SRC, [".css", ".svelte", ".ts"]);

const defined = new Set();
const referenced = new Map(); // name -> Set<file>

const DECL = /(?:^|[;{\s"'])(--[a-zA-Z0-9-]+)\s*:/g; // CSS custom-property declaration
const SETPROP = /setProperty\(\s*["'](--[a-zA-Z0-9-]+)["']/g; // JS runtime definition
const STYLE_DIR = /style:(--[a-zA-Z0-9-]+)/g; // Svelte style:--x directive
const REF = /var\(\s*(--[a-zA-Z0-9-]+)/g;

for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const re of [DECL, SETPROP, STYLE_DIR]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) defined.add(m[1]);
  }
  REF.lastIndex = 0;
  let m;
  while ((m = REF.exec(text))) {
    const name = m[1];
    if (!referenced.has(name)) referenced.set(name, new Set());
    referenced.get(name).add(relative(root, f));
  }
}

// Only design-tokens are enforced; local/runtime custom properties are out of scope.
const undef = [...referenced.keys()].filter((n) => isToken(n) && !defined.has(n)).sort();
const enforced = [...referenced.keys()].filter(isToken).length;

if (undef.length) {
  console.error("TOKENS VERIFY: FAIL — design tokens referenced but never defined:\n");
  for (const n of undef) {
    console.error(`  ${n}`);
    for (const f of referenced.get(n)) console.error(`      ${f}`);
  }
  console.error(`\n${undef.length} undefined token(s). Define them in src/styles/tokens.css or fix the reference.`);
  process.exit(1);
}

console.log(`TOKENS VERIFY: PASS — ${enforced} design-token references checked, all defined in tokens.css.`);
