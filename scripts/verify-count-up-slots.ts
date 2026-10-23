// WP 2.3 (T8 D5) — count-up PLACE-VALUE SLOTS, in real Chrome (the gate needs real glyph metrics: `getSubStringLength`,
// `getExtentOfChar`). A proportional font (Georgia, the theme's first family, has no `tnum`) makes a counting number's digits wander:
// on a 0 -> 1,234.5 ramp the glyph centres jittered 2.9 px median / 23.4 p90 / 49.6 max at 192 px/em. Each digit now sits in a slot as
// wide as the FINAL text's digit at the same place value, so the centres of same-length frames do not move at all.
//   • every character of same-length frames keeps its centre x (0 px; the same frames with `steadyDigits:false` jitter, so the gate sees);
//   • the final frame is the authored text, byte for byte, with the node's own `dx` restored (none): no relax, no snap;
//   • `47%`: digits still when pinned left, the `%` and a centred line within a kerning residue;
//   • a text with no layout (detached) yields no `dx` and no exception, and `dx` appears at the next seek once it renders;
//   • `steadyDigits:false`, a `textLength` line and HTML text are untouched; a seek is a pure function of t.
// macOS / Windows Georgia kerning is NOT checked here (this box renders msttcorefonts Georgia): owed to the owner smoke test.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-count-up-slots");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-count-up-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  const bundled = await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    import { createCountUp } from "./src/lib/slide/player/countup";
    const NS = "http://www.w3.org/2000/svg";
    const stage = document.getElementById("stage");
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "1600"); svg.setAttribute("height", "700"); stage.appendChild(svg);
    const FONT = "font-family:Georgia, 'Noto Serif', serif;font-size:192px";
    const make = (text, extra = {}, host = svg) => {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", "40"); t.setAttribute("y", "220"); t.setAttribute("style", FONT);
      for (const [k, v] of Object.entries(extra)) t.setAttribute(k, v);
      t.textContent = text; host.appendChild(t); return t;
    };
    // the centre x of every character and the whole extent, in user units
    const centres = (node) => { const out = []; for (let i = 0; i < node.getNumberOfChars(); i++) { const b = node.getExtentOfChar(i); out.push(b.x + b.width / 2); } return out; };
    const sweep = (node, ctl, n) => {
      const frames = new Map();
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1); ctl.seek(u, u);
        const text = node.textContent, key = text.length;
        if (u >= 1) continue;
        (frames.get(key) ?? frames.set(key, []).get(key)).push({ text, c: centres(node), width: node.getComputedTextLength() });
      }
      // per same-length group: the largest spread of each character's centre
      const out = [];
      for (const [len, list] of frames) {
        const spread = Array.from({ length: len }, (_, k) => Math.max(...list.map(f => f.c[k])) - Math.min(...list.map(f => f.c[k])));
        out.push({ len, frames: list.length, chars: list[0].text, spread, width: Math.max(...list.map(f => f.width)) - Math.min(...list.map(f => f.width)) });
      }
      return out;
    };
    const track = (params) => ({ id: "t", target: "x", preset: "countUp", params });
    globalThis.probe = {
      big(steady, anchor = "start") {
        const node = make("1,234.5", anchor === "start" ? {} : { "text-anchor": anchor, x: anchor === "middle" ? "800" : "1500" }), ctl = createCountUp(node, track(steady ? { from: 0 } : { from: 0, steadyDigits: false }));
        const groups = sweep(node, ctl, 1200);
        ctl.seek(1, 1);
        return { groups, final: node.textContent, finalDx: node.getAttribute("dx"), attrs: node.getAttributeNames().sort() };
      },
      pct(steady, anchor) {
        const node = make("47%", anchor === "start" ? {} : { "text-anchor": anchor, x: anchor === "middle" ? "800" : "1400" }), ctl = createCountUp(node, track(steady ? { from: 0 } : { from: 0, steadyDigits: false }));
        const groups = sweep(node, ctl, 600);
        ctl.seek(1, 1);
        return { groups, final: node.textContent, finalDx: node.getAttribute("dx") };
      },
      pure() {
        const node = make("1,234.5"), ctl = createCountUp(node, track({ from: 0 })), at = (u) => { ctl.seek(u, u); return node.textContent + "|" + node.getAttribute("dx"); };
        const ts = Array.from({ length: 40 }, (_, i) => i / 39), fwd = ts.map(at), rev = [...ts].reverse().map(at).reverse();
        const order = ts.map((_, i) => i).sort((a, b) => ((a * 7919) % 41) - ((b * 7919) % 41)), shuf = []; for (const i of order) shuf[i] = at(ts[i]);
        return { same: JSON.stringify(fwd) === JSON.stringify(rev), shuffled: JSON.stringify(fwd) === JSON.stringify(shuf), distinct: new Set(fwd).size };
      },
      noLayout() {
        // a text with no rendering (a detached subtree) cannot be measured: getSubStringLength throws there
        const detached = document.createElementNS(NS, "svg"), node = document.createElementNS(NS, "text");
        node.setAttribute("style", FONT); node.textContent = "1,234.5"; detached.appendChild(node);
        const ctl = createCountUp(node, track({ from: 0 }));
        let threw = ""; try { ctl.seek(.5, .5); } catch (e) { threw = String(e); }
        const detachedDx = node.getAttribute("dx"), detachedText = node.textContent;
        stage.appendChild(detached); ctl.seek(.5, .5);
        const attachedDx = node.getAttribute("dx");
        // a display:none host: either no layout (no dx) or a full measurement (a dx entry per character), never an exception
        const wrap = document.createElementNS(NS, "g"); wrap.setAttribute("style", "display:none"); svg.appendChild(wrap);
        const hid = make("1,234.5", {}, wrap), hc = createCountUp(hid, track({ from: 0 }));
        let hiddenThrew = ""; try { hc.seek(.5, .5); } catch (e) { hiddenThrew = String(e); }
        const hdx = hid.getAttribute("dx");
        return { threw, detachedDx, detachedText, attachedDx, hiddenThrew, hiddenOk: hdx === null || hdx.split(" ").length === hid.textContent.length };
      },
      untouched() {
        const off = make("1,234.5"), a = createCountUp(off, track({ from: 0, steadyDigits: false })); a.seek(.5, .5);
        const just = make("1,234.5", { textLength: "700", lengthAdjust: "spacing" }), b = createCountUp(just, track({ from: 0 })); b.seek(.5, .5);
        const html = document.createElement("div"); html.style.cssText = FONT; html.textContent = "1,234.5"; stage.appendChild(html);
        const c = createCountUp(html, track({ from: 0 })); c.seek(.5, .5);
        const own = make("1,234.5", { dx: "0 0 0 0 0 0 0" }), d = createCountUp(own, track({ from: 0 })); d.seek(.5, .5); const during = own.getAttribute("dx"); d.seek(1, 1);
        return { off: off.getAttribute("dx"), textLength: just.getAttribute("dx"), html: html.getAttribute("dx"), htmlText: html.textContent, ownDuring: during, ownAfter: own.getAttribute("dx") };
      },
      fonts() {
        const node = make("0123456789"), adv = Array.from({ length: 10 }, (_, i) => node.getSubStringLength(i, 1));
        return { family: getComputedStyle(node).fontFamily, adv, proportional: Math.max(...adv) - Math.min(...adv) };
      },
    };
  ` }, bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent" });
  h.eq(bundled.warnings.length, 0, "the browser runtime bundles without warnings");
  await fs.writeFile(path.join(tmp, "runtime.js"), bundled.outputFiles[0].contents);
  await fs.writeFile(path.join(tmp, "index.html"), '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'"><div id="stage"></div><script src="runtime.js"></script>');
  const launched = await launch(); browser = launched.browser;
  const errors: string[] = [];
  launched.page.on("pageerror", (e: Error) => errors.push(String(e)));
  launched.page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await launched.page.goto(pathToFileURL(path.join(tmp, "index.html")).href);
  await launched.page.evaluate(() => document.fonts.ready.then(() => 0));
  const probe = <T>(name: string, ...args: unknown[]) => launched.page.evaluate((n, a) => (globalThis as any).probe[n](...a), name, args) as Promise<T>;
  type Group = { len: number; frames: number; chars: string; spread: number[]; width: number };
  type Ramp = { groups: Group[]; final: string; finalDx: string | null; attrs?: string[] };
  const worst = (r: Ramp) => Math.max(...r.groups.flatMap(g => g.spread));

  const fonts = await probe<{ family: string; adv: number[]; proportional: number }>("fonts");
  h.ok(fonts.proportional > 1, `the test font is proportional (digit advances differ by ${fonts.proportional.toFixed(1)} px; ${fonts.family})`);

  h.section("0 -> 1,234.5 at 192 px/em: every character of same-length frames keeps its centre");
  const slots = await probe<Ramp>("big", true, "start"), plain = await probe<Ramp>("big", false, "start");
  h.ok(slots.groups.length >= 3 && slots.groups.every(g => g.frames >= 5), `the ramp covers ${slots.groups.length} text lengths (${slots.groups.map(g => `${g.len}:${g.frames}`).join(" ")})`);
  h.ok(worst(slots) < 0.02, `slots: worst glyph-centre spread ${worst(slots).toFixed(4)} px (the proportional ramp: ${worst(plain).toFixed(1)} px)`);
  h.ok(worst(plain) > 5, "the same frames with steadyDigits:false DO jitter (the gate would fail without slots)");
  for (const anchor of ["middle", "end"]) {
    const held = await probe<Ramp>("big", true, anchor), loose = await probe<Ramp>("big", false, anchor);
    h.ok(worst(held) < 0.05 && worst(held) < worst(loose) / 100, `text-anchor ${anchor}: the same ramp holds still about its anchor (${worst(held).toFixed(4)} px vs plain ${worst(loose).toFixed(1)})`);
  }
  h.eq(slots.final, "1,234.5", "the final frame is the authored text");
  h.eq(slots.finalDx, null, "and carries no dx at all (byte-identical to the authored node: no relax, no snap)");
  h.eq(plain.finalDx, null, "steadyDigits:false never writes one");

  h.section("47%: digits still when pinned left; centred text keeps them within a kerning residue");
  const pct = await probe<Ramp>("pct", true, "start"), pctPlain = await probe<Ramp>("pct", false, "start");
  const same3 = (r: Ramp) => r.groups.filter(g => g.len === 3);
  const digits = (r: Ramp) => Math.max(...same3(r).flatMap(g => g.spread.slice(0, 2)));
  h.ok(digits(pct) < 0.02, `pinned left: the digits keep their centres (${digits(pct).toFixed(4)} px; plain ${digits(pctPlain).toFixed(1)} px)`);
  const percent = (r: Ramp) => Math.max(...same3(r).map(g => g.spread[2]));
  h.ok(percent(pct) < 0.05 * 192, `and the % moves only a kerning residue (${percent(pct).toFixed(2)} px; plain ${percent(pctPlain).toFixed(2)}; bound 0.05 em = ${(0.05 * 192).toFixed(1)} px)`);
  h.eq([pct.final, pct.finalDx], ["47%", null], "the final frame is the authored text with no dx");
  for (const anchor of ["middle", "end"]) {
    const held = await probe<Ramp>("pct", true, anchor), loose = await probe<Ramp>("pct", false, anchor);
    const spread = (r: Ramp) => Math.max(...same3(r).flatMap(g => g.spread));
    // a font that kerns a digit against the % widens the text by that kerning, which the anchor then halves / doubles: a residue, never a wander
    h.ok(spread(held) < 0.05 * 192 && spread(held) < spread(loose) / 3, `text-anchor ${anchor}: every glyph moves only a kerning residue (${spread(held).toFixed(3)} px vs plain ${spread(loose).toFixed(2)}; bound ${(0.05 * 192).toFixed(1)})`);
  }

  h.section("a seek is a pure function of t");
  const pure = await probe<{ same: boolean; shuffled: boolean; distinct: number }>("pure");
  h.ok(pure.same && pure.shuffled && pure.distinct > 10, `forward == reverse == shuffled seeks (${pure.distinct} distinct frames)`);

  h.section("no layout: nothing breaks, nothing is cached, dx follows once the text renders");
  const nl = await probe<{ threw: string; detachedDx: string | null; detachedText: string; attachedDx: string | null; hiddenThrew: string; hiddenOk: boolean }>("noLayout");
  h.eq(nl.threw, "", "a detached text (getSubStringLength raises there) does not throw");
  h.ok(nl.detachedDx === null && /^\d/.test(nl.detachedText), "it gets the counted text and no dx");
  h.ok(!!nl.attachedDx && nl.attachedDx.split(" ").length === nl.detachedText.length, "the failure was not cached: dx appears at the next seek once it renders");
  h.ok(nl.hiddenThrew === "" && nl.hiddenOk, "a display:none host never throws and never writes a malformed dx");

  h.section("untouched cases");
  const un = await probe<{ off: string | null; textLength: string | null; html: string | null; htmlText: string; ownDuring: string | null; ownAfter: string | null }>("untouched");
  h.eq(un.off, null, "steadyDigits:false writes no dx");
  h.eq(un.textLength, null, "a textLength (justified) line writes no dx: it would fight the justification");
  h.eq([un.html, /^[\d,.]+$/.test(un.htmlText)], [null, true], "HTML text counts but gets no dx (no per-glyph offsets there)");
  h.ok(un.ownDuring !== "0 0 0 0 0 0 0" && un.ownAfter === "0 0 0 0 0 0 0", `a node's own dx is replaced while counting and restored at the end (${un.ownAfter})`);
  h.eq(errors, [], "no browser errors or CSP violations");
} finally {
  await browser?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
await h.done();
