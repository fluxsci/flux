// The artifact bridge in a real browser: the script every artifact page runs
// (electron/artifactRules.js `artifactBridge`), served by the app's own file server, in a frame
// of a small host page that plays the app. What only a browser can show:
//   A. a comment's passage is FOUND AGAIN in the page: across paragraphs, among repeats (by the
//      words around it), after the page is rewritten around it, after it is reworded in the
//      middle; and reported gone when it is gone;
//   B. a commented element is found by its path, and by its label when the path moved;
//   C. passages are drawn with the CSS highlight registry: not one node of the page changes;
//   D. a selection is reported with the words around it and where it is; the pointer resting on
//      a commented passage, and a press on it, are reported with the passage's box;
//   E. picking: the element under the pointer is described (path, kind, label, heading) and the
//      page does not act on the press; Escape abandons it;
//   F. what it costs: indexing the text of a large page, and placing comments on it.
//
// Run: node scripts/run-verifies.mjs --tier pure --only verify-artifact-bridge-browser.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";
import { perfBudget } from "./lib/perfBudget.mjs";
import { createArtifactDevRoutes } from "./lib/artifactDevRoutes.mjs";
import { parseFrameMessage, type FrameMessage } from "../src/lib/artifacts/frameProtocol";

const h = harness("verify-artifact-bridge-browser");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flux-artifact-bridge-")));
const root = path.join(scratch, "artifacts");
fs.mkdirSync(path.join(root, "page"), { recursive: true });
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Bridge page</title>
<style>body{font:16px/1.5 serif;margin:20px;width:700px} .tall{height:1600px} #plot{width:300px;height:120px;background:#eee}</style></head><body>
<h1>Results</h1>
<p id="p1">The control series plateaus by 18 h. The stressed series keeps rising.</p>
<p id="p2">Growth slowed under stress.</p>
<h2>Methods</h2>
<p id="p3">Hyphal length was measured every six hours. Growth slowed under stress, as expected.</p>
<figure id="fig"><div id="plot" aria-label="Growth curve"></div><figcaption>Figure 1. Length over time.</figcaption></figure>
<table id="t"><caption>Lengths</caption><tr><td>18</td><td>5.2</td></tr></table>
<button id="btn" onclick="window.__pressed = (window.__pressed || 0) + 1">Run</button>
<div class="tall"></div>
<script>window.__data = "The control series plateaus by 18 h, in a script: this is not text.";</script>
</body></html>`;
fs.writeFileSync(path.join(root, "page/index.html"), PAGE);
const routes = createArtifactDevRoutes({ projectDir: root, projectRoot: scratch });
const HOST = `<!doctype html><meta charset="utf-8"><title>host</title><body style="margin:0">
<script>window.__msgs = []; addEventListener("message", (e) => { if (e.data && e.data.fluxArtifact === 1) window.__msgs.push(e.data); });
window.send = (m) => document.querySelector("iframe").contentWindow.postMessage(Object.assign({ fluxArtifact: 1 }, m), "*");</script>
<iframe style="border:0;width:900px;height:600px;display:block"></iframe></body>`;
const server = http.createServer((req, res) => {
  if (req.url === "/host.html") { res.writeHead(200, { "Content-Type": "text/html" }); return void res.end(HOST); }
  void routes.handler(req, res, () => { res.statusCode = 404; res.end(); });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const listing = await routes.listing();
const pageUrl = origin + listing.roots[0].artifacts[0].pages[0].url;

const { browser, page } = await launch({ width: 1000, height: 700 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  await page.goto(`${origin}/host.html`);
  const frame = () => page.frames().find((f) => f.url().includes("/__flux-dev/artifacts/serve/"))!;
  const msgs = async (type: string) => (await page.evaluate(() => (window as unknown as { __msgs: unknown[] }).__msgs)).map(parseFrameMessage).filter((m): m is FrameMessage => !!m && m.type === type);
  const clear = () => page.evaluate(() => { (window as unknown as { __msgs: unknown[] }).__msgs.length = 0; });
  const send = (m: Record<string, unknown>) => page.evaluate((msg) => (window as unknown as { send: (m: unknown) => void }).send(msg), m);
  const until = async <T>(read: () => Promise<T | null | undefined | false>, label: string, timeout = 6000): Promise<T> => {
    const t0 = Date.now();
    for (;;) { const v = await read(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error(`timed out: ${label}`); await sleep(40); }
  };
  /** Ask the page to place these comments; resolves to which were found. */
  const place = async (items: Record<string, unknown>[]) => {
    await clear();
    await send({ type: "anchors", items, color: "#4385be" });
    const report = await until(async () => (await msgs("anchors")).at(-1), "anchors report");
    return Object.fromEntries((report as Extract<FrameMessage, { type: "anchors" }>).items.map((a) => [a.id, a.found]));
  };
  /** The text each highlight covers, as the registry holds it. */
  const highlighted = () => frame().evaluate(() => {
    const reg = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("flux-comment");
    return reg ? [...reg].map((r) => r.toString().replace(/\s+/g, " ")) : [];
  });
  const load = async () => {
    await clear();
    await page.evaluate((url) => { document.querySelector("iframe")!.src = url; }, pageUrl);
    await until(async () => (await msgs("ready")).length > 0, "the page answers");
  };
  await load();
  h.eq((await msgs("outline")).at(-1), { type: "outline", items: [{ level: 1, text: "Results" }, { level: 2, text: "Methods" }] }, "the page answers with its outline");

  // -------------------------------------------------------------------------------------------
  h.section("A. A passage is found again");
  const htmlBefore = await frame().evaluate(() => document.body.innerHTML);
  let found = await place([
    { id: "one", quote: "plateaus by 18 h", prefix: "Thecontrolseries", suffix: ".Thestressedseries" },
    { id: "across", quote: "keeps rising.\n\nGrowth slowed", prefix: "stressedseries", suffix: "understress." },
    { id: "second", quote: "Growth slowed under stress", prefix: "everysixhours.", suffix: ",asexpected." },
    { id: "first", quote: "Growth slowed under stress", prefix: "keepsrising.", suffix: ".Methods" },
    { id: "script", quote: "in a script: this is not text" },
    { id: "absent", quote: "words that are nowhere on this page" },
  ]);
  h.eq(found, { one: true, across: true, second: true, first: true, script: false, absent: false }, "passages are found; a script's text and absent words are not");
  let drawn = await highlighted();
  h.eq(drawn.slice(0, 2), ["plateaus by 18 h", "keeps rising. Growth slowed"], "the highlight covers exactly the quoted words; a selection across two paragraphs is matched across them");
  const where = await frame().evaluate(() => [...(CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("flux-comment")!].map((r) => (r.startContainer.parentElement as HTMLElement).id));
  h.eq([where[2], where[3]], ["p3", "p2"], "the same words twice: each comment keeps the occurrence its surroundings name");

  // The page is rewritten around the passages (a build ran): new sections, the same sentences elsewhere. The page
  // places its comments again by itself, 400 ms after its last change; it reports only when what was found changed,
  // so what it drew is read from the highlight registry.
  const drawnIn = () => frame().evaluate(() => [...((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("flux-comment") ?? [])].map((r) => `${(r.startContainer.parentElement?.closest("[id]") as HTMLElement | null)?.id ?? ""}:${r.toString().replace(/\s+/g, " ")}`));
  await frame().evaluate(() => {
    document.getElementById("p1")!.outerHTML = '<section><h2>New summary</h2><p>Twelve cultures grew.</p><p id="p1b">The <b>control</b> series <i>plateaus</i> by 18&nbsp;h. The stressed series keeps rising.</p></section>';
  });
  await until(async () => (await drawnIn()).includes("p1b:plateaus by 18 h"), "the passage is found in the rewritten page");
  h.ok(true, "after the page is rewritten around it (new markup inside the words, a no-break space), the passage is found again by itself, the same words");
  // Reworded in the middle: its first and last words still bound it.
  found = await place([{ id: "long", quote: "Hyphal length was measured every six hours. Growth slowed under stress, as expected." }]);
  h.eq(found.long, true, "a long passage is found");
  await frame().evaluate(() => { document.getElementById("p3")!.textContent = "Hyphal length was measured each morning and evening. Growth slowed under stress, as expected."; });
  await until(async () => (await drawnIn()).includes("p3:Hyphal length was measured each morning and evening. Growth slowed under stress, as expected."), "the reworded passage is found");
  h.ok(true, "reworded in the middle, it is still found: its first and last words bound it");
  await clear();
  await frame().evaluate(() => { document.getElementById("p3")!.remove(); });
  const gone = await until(async () => (await msgs("anchors")).at(-1), "report after removal") as Extract<FrameMessage, { type: "anchors" }>;
  h.eq([gone.items[0].found, (await highlighted()).length], [false, 0], "removed from the page, it is reported gone and nothing is drawn");

  // -------------------------------------------------------------------------------------------
  h.section("B. An element is found again");
  found = await place([{ id: "fig", selector: "#plot", tag: "div", label: "Growth curve" }, { id: "table", selector: "#t", tag: "table", label: "Lengths" }, { id: "nothing", selector: "#nope", tag: "canvas", label: "Missing" }]);
  h.eq(found, { fig: true, table: true, nothing: false }, "elements are found by their path");
  await frame().evaluate(() => { const t = document.getElementById("t")!; t.removeAttribute("id"); const wrap = document.createElement("div"); t.replaceWith(wrap); wrap.appendChild(t); });
  found = await place([{ id: "table", selector: "#t", tag: "table", label: "Lengths" }, { id: "other", selector: "#t", tag: "table", label: "Another table" }]);
  h.eq(found, { table: true, other: false }, "its path moved and its id is gone: the table is found by its caption, and a table with another caption is not taken for it");

  // -------------------------------------------------------------------------------------------
  h.section("C. The page is not changed");
  await load();
  const before = await frame().evaluate(() => document.body.innerHTML);
  found = await place([{ id: "one", quote: "plateaus by 18 h" }, { id: "fig", selector: "#plot", tag: "div", label: "Growth curve" }]);
  const after = await frame().evaluate(() => ({ body: document.body.innerHTML, layer: document.querySelectorAll("flux-artifact-marks").length, style: document.querySelectorAll("style[data-flux-artifact]").length, marks: document.querySelectorAll("mark, span[data-flux]").length }));
  h.ok(found.one && found.fig && after.body === before && before === htmlBefore, "with a passage and an element marked, the page's body is byte for byte what it was");
  h.eq([after.layer, after.style, after.marks], [1, 1, 0], "the marks are one element of ours outside the body, and one style; nothing is wrapped around the words");
  h.eq(await frame().evaluate(() => getComputedStyle(document.querySelector("flux-artifact-marks")!).pointerEvents), "none", "which the pointer passes through");

  // -------------------------------------------------------------------------------------------
  h.section("D. Selections and the pointer");
  await clear();
  await frame().evaluate(() => { const t = document.getElementById("p2")!.firstChild!, r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 13); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); });
  const sel = await until(async () => (await msgs("selection")).find((m) => m.type === "selection" && m.text), "the selection is reported") as Extract<FrameMessage, { type: "selection" }>;
  h.eq([sel.text, sel.prefix, sel.suffix, sel.heading], ["Growth slowed", "8h.Thestressedserieskeepsrising.", "understress.MethodsHyphallengthw", "Results"], "a selection: its words, the 32 characters on each side of it (white space left out), and its heading");
  h.ok(!!sel.rect && sel.rect.w > 40 && sel.rect.h > 10 && sel.rect.y > 0, `and where it is (${JSON.stringify(sel.rect)})`);
  await frame().evaluate(() => getSelection()!.removeAllRanges());
  await place([{ id: "one", quote: "plateaus by 18 h" }]);
  const box = await frame().evaluate(() => { const r = [...(CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("flux-comment")!][0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const fbox = (await (await page.$("iframe"))!.boundingBox())!;
  await clear();
  await page.mouse.move(fbox.x + box.x - 3, fbox.y + box.y);
  await page.mouse.move(fbox.x + box.x, fbox.y + box.y);
  const hover = await until(async () => (await msgs("anchor")).find((m) => m.type === "anchor" && m.how === "hover"), "the pointer resting on a passage is reported") as Extract<FrameMessage, { type: "anchor" }>;
  h.ok(hover.id === "one" && !!hover.rect && Math.abs(hover.rect.y + hover.rect.h / 2 - box.y) < 14, "the pointer resting on a commented passage names the comment and the line under it");
  await clear();
  await page.mouse.click(fbox.x + box.x, fbox.y + box.y);
  const click = await until(async () => (await msgs("anchor")).find((m) => m.type === "anchor" && m.how === "click"), "a press on a passage is reported") as Extract<FrameMessage, { type: "anchor" }>;
  h.eq(click.id, "one", "a press on it opens that comment");
  await clear();
  await page.mouse.move(fbox.x + 600, fbox.y + 420);
  await until(async () => (await msgs("anchor")).find((m) => m.type === "anchor" && m.how === "leave"), "leaving the passage is reported");
  h.ok(true, "moving off it says so");
  await clear();
  await send({ type: "active", id: "one", reveal: true });
  const move = await until(async () => (await msgs("anchor")).find((m) => m.type === "anchor" && m.how === "move"), "an active comment reports where it is") as Extract<FrameMessage, { type: "anchor" }>;
  h.ok(move.id === "one" && (await frame().evaluate(() => (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("flux-comment-on")?.size)) === 1, "the comment the app shows is drawn stronger and says where it is");

  // -------------------------------------------------------------------------------------------
  h.section("E. Picking an element");
  await send({ type: "pick", on: true });
  await until(() => frame().evaluate(() => document.documentElement.hasAttribute("data-flux-pick")), "pick mode");
  const plot = await frame().evaluate(() => { const r = document.getElementById("plot")!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await clear();
  await page.mouse.move(fbox.x + plot.x - 4, fbox.y + plot.y);
  await page.mouse.move(fbox.x + plot.x, fbox.y + plot.y);
  await page.mouse.click(fbox.x + plot.x, fbox.y + plot.y);
  const pick = await until(async () => (await msgs("pick")).at(-1), "the pick is reported") as Extract<FrameMessage, { type: "pick" }>;
  h.ok(!pick.cancel && pick.selector === "#plot" && pick.tag === "div" && pick.label === "Growth curve" && pick.heading === "Methods" && pick.rect.w > 250, `a press picks the nearest thing with a name under the pointer: its path, kind, label and heading (${JSON.stringify({ ...pick, rect: undefined })})`);
  // The caption below the plot belongs to the figure: a press there picks the figure, named by its caption.
  await send({ type: "pick", on: true });
  const cap = await frame().evaluate(() => { const r = document.querySelector("figcaption")!.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
  await clear();
  await page.mouse.click(fbox.x + cap.x, fbox.y + cap.y);
  const pick2 = await until(async () => (await msgs("pick")).at(-1), "the figure is picked") as Extract<FrameMessage, { type: "pick" }>;
  h.ok(!pick2.cancel && pick2.selector === "#fig" && pick2.tag === "figure" && pick2.label === "Figure 1. Length over time.", `a press on a figure's caption picks the figure (${JSON.stringify({ ...pick2, rect: undefined })})`);
  h.ok(!(await frame().evaluate(() => document.documentElement.hasAttribute("data-flux-pick"))), "and picking is over");
  await send({ type: "pick", on: true });
  const btn = await frame().evaluate(() => { const r = document.getElementById("btn")!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await clear();
  await page.mouse.click(fbox.x + btn.x, fbox.y + btn.y);
  await until(async () => (await msgs("pick")).length > 0, "a pick on the button");
  h.eq(await frame().evaluate(() => (window as unknown as { __pressed?: number }).__pressed ?? 0), 0, "while picking, the page does not act on the press (its button did not run)");
  await send({ type: "pick", on: true });
  await clear();
  await frame().evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  const cancel = await until(async () => (await msgs("pick")).at(-1), "Escape abandons picking") as Extract<FrameMessage, { type: "pick" }>;
  h.eq(cancel.cancel, true, "Escape abandons it");

  // -------------------------------------------------------------------------------------------
  h.section("F. What it costs");
  // A page of ~1.2 million characters of text in 20,000 paragraphs, 40 comments on it.
  await frame().evaluate(() => {
    const host = document.createElement("div");
    host.id = "bulk";
    const parts: string[] = [];
    for (let i = 0; i < 20000; i++) parts.push(`<p>Paragraph ${i}: the recording shows a state of sparse input followed by a coordinated one, n=${i * 7}.</p>`);
    host.innerHTML = parts.join("");
    document.body.appendChild(host);
  });
  await sleep(700); // the page's own pass after that change (400 ms after the last mutation) is not what is timed
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, quote: `Paragraph ${i * 499}: the recording shows a state`, suffix: "ofsparseinput" }));
  // The bridge answers a request in the task that delivers it, so it is timed from inside the page: the request is
  // handed to its listener as the app's message would be (same origin here, so the frame may name its parent).
  const timed = (items: unknown) => frame().evaluate((list) => {
    const t0 = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { fluxArtifact: 1, type: "anchors", items: list, color: "#4385be" }, source: window.parent }));
    return { ms: performance.now() - t0, found: (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("flux-comment")?.size ?? 0 };
  }, items);
  const cold = await timed(many);
  const budget = perfBudget(400);
  h.ok(cold.found === 40 && cold.ms < budget.ms, `40 comments placed on a page of 1.2 million characters, its text read first: ${cold.ms.toFixed(0)} ms (< ${budget.text}), all found`);
  const warm = await timed(many);
  const warmBudget = perfBudget(60);
  h.ok(warm.found === 40 && warm.ms < warmBudget.ms, `placed again with the text already read: ${warm.ms.toFixed(1)} ms (< ${warmBudget.text})`);
} catch (e) {
  h.fail(`${(e as Error)?.stack || e}`);
}
await h.done(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
});
