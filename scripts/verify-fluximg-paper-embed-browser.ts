#!/usr/bin/env -S npx tsx
// fluximg stage 2: a Paper inline slide that holds an image, in a real browser (review S2 "not done").
//   * the EXPORTED Paper HTML (portable: stills + baked clips inline, the offline CSP of hashes): the embed mounts, its
//     image shows its still, the next step plays the Change's clip and ends on the end still, no CSP violation;
//   * the LIVE preview document (the app's preview CSP, electron/slideEmbedCsp.gen.cjs): the same, with stills only;
//   * each carries the image runtime once (review B5); a document whose slides hold no image carries none.
// Run: FLUX_VIDEO_ENCODER=<build/video-encoder/linux-x64/ffmpeg> npx tsx scripts/verify-fluximg-paper-embed-browser.ts
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { harness } from "./lib/harness.mjs";
import { makeProject, standardDeck } from "./lib/fluximgSlideExportFixture";

const h = harness("verify-fluximg-paper-embed-browser");
const P = await makeProject();
const { ensureDom } = await import("../flux-core/index");
await ensureDom();
const { launch, errors } = await import("./lib/driver.mjs");
const { nodeSlideImageIO, fluximgRenderSession } = await import("../flux-core/fluximgRender");
const { nodeImageIO } = await import("../flux-core/slides");
const { imageClipEncoder } = await import("../flux-core/fluximgClip");
const { createSlideRepository } = await import("../src/lib/slide/embedRepository");
const { prepareSlideDocument } = await import("../src/lib/slide/embedDocument");
const { offlineHtmlPolicy } = await import("../src/lib/offlineHtmlPolicy");
const { ensureColormapLuts } = await import("../src/lib/color/colormapLuts");
await ensureColormapLuts();
const deck = await standardDeck(P);
const slide = deck.slides[0];
const encoder = await imageClipEncoder();
const liveCsp = (await import(path.resolve("electron/slideEmbedCsp.gen.cjs"))).default as string;

/** A Paper document around one inline slide, as renderManuscript composes it (body, the slide blocks, the tail). */
async function paperDocument(portable: boolean) {
  const base = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p), ...nodeSlideImageIO(P.root, fluximgRenderSession()) };
  // The exported document's IO bakes clips (Node: flux-core's image IO); the live preview's draws stills only.
  const io = portable ? { ...base, ...(await nodeImageIO(P.root, {})) } : base;
  const repo = createSlideRepository(P.root, io as any);
  const src = `# A paper\n\nText before.\n\n![The image slide](slides/talk.slide){#fig-img .flux-slide deck="talk" slide="${slide.id}"}\n\nText after.\n`;
  const doc = await prepareSlideDocument(src, repo, { interactive: true, live: !portable, strict: portable, documentKey: "k" });
  let body = doc.text;
  for (const b of doc.blocks) body = body.replace(b.token, b.html);
  const scripts = [...doc.tail.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const csp = portable ? await offlineHtmlPolicy(scripts)
    : `default-src 'self'; script-src 'self' ${liveCsp}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src data:`;
  repo.dispose();
  return { html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${doc.style}</head><body>${body}${doc.tail}</body></html>`, tail: doc.tail };
}

const { browser, page } = await launch({ width: 1200, height: 900 });
const errs = errors(page);
const csp: string[] = [];
page.on("console", (m: any) => { if (/Content Security Policy|Refused to/.test(m.text())) csp.push(m.text()); });
try {
  for (const portable of [true, false]) {
    const label = portable ? "exported Paper HTML" : "live preview document";
    h.section(label);
    const { html, tail } = await paperDocument(portable);
    h.eq((tail.match(/var FluxImageRuntimeFactory=/g) ?? []).length, 1, "the image runtime, once");
    h.ok(portable ? tail.includes('"imageClips"') === !!encoder : !tail.includes('"imageClips"'), portable ? `clips inline${encoder ? "" : " (none: no encoder)"}` : "stills only (no clips in the live preview)");
    const file = path.join(P.scratch, portable ? "paper.html" : "live.html");
    await fs.writeFile(file, html);
    await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector(".flux-slide-embed")?.classList.contains("flux-slide-enhanced"), { timeout: 15000 });
    h.ok(true, "the inline slide mounts its player (enhanced)");
    const stillHref = () => page.evaluate(() => { const s = document.querySelector(".flux-slide-live [data-fluximg-still]") as HTMLElement | null; const href = s && s.style.display !== "none" ? s.querySelector("image")?.getAttribute("href") ?? "" : ""; return href.startsWith("data:image/png") ? href : ""; });
    const still = await page.waitForFunction(() => { const s = document.querySelector(".flux-slide-live [data-fluximg-still]") as HTMLElement | null; return !!s && s.style.display !== "none" && !!s.querySelector("image")?.getAttribute("href")?.startsWith("data:image/png"); }, { timeout: 15000 }).then(() => stillHref()).catch(() => "");
    h.ok(!!still, "the image shows its still in the embed");
    // Next: the walk (1 s). An exported document plays its clip; both end on the end still.
    await page.click(".flux-slide-bar button[aria-label='Next animation step']");
    if (portable && encoder) {
      const played = await page.waitForFunction(() => { const v = document.querySelector(".flux-slide-live video[data-slide-fluximg-clip]") as HTMLVideoElement | null; return v && v.readyState >= 2 ? true : null; }, { timeout: 8000 }).then(() => true).catch(() => false);
      h.ok(played, "the Change plays its baked clip in a <video>");
    }
    await new Promise((r) => setTimeout(r, 1600));
    const end = { ...(await page.evaluate(() => { const v = document.querySelector(".flux-slide-live video[data-slide-fluximg-clip]") as HTMLVideoElement | null; return { videoShown: !!v && v.style.display !== "none", bar: document.querySelector(".flux-slide-bar")?.textContent ?? "" }; })), still: await stillHref() };
    h.ok(!end.videoShown && !!end.still && end.still !== still, `at rest after the step: the end still, no video over it (${end.bar.replace(/\s+/g, " ").trim().slice(0, 60)})`);
  }
  h.section("a Paper document without images");
  {
    await P.core.createDeck(P.root, { id: "plain", title: "Plain" });
    const plainDeck = await P.slidesCore.loadDeck(P.root, "plain");
    const repo = createSlideRepository(P.root, { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p) } as any);
    const doc = await prepareSlideDocument(`![x](slides/plain.slide){.flux-slide deck="plain" slide="${plainDeck.slides[0].id}"}\n`, repo, { interactive: true, strict: true });
    repo.dispose();
    h.ok(doc.tail.includes("flux-slide-data") && !doc.tail.includes("var FluxImageRuntimeFactory="), `its tail carries the player and no image runtime`);
  }
  h.eq(csp, [], "no CSP violation");
  h.eq(errs.length ? errs : [], [], "no console errors");
} finally {
  await browser.close();
  await fs.rm(P.scratch, { recursive: true, force: true });
}
await h.done();
