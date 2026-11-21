#!/usr/bin/env -S npx tsx
// Review B5 (fluximg stage 2): a document without images pays nothing for images. The base runtimes (eager deck,
// video capture, Paper embed) hold no image code: they reach it only through `slide/imageSeam.ts`, and the image kit
// rides in the CONDITIONAL image runtime (`FluxImageRuntime`), inlined once into documents whose payload holds an image.
//   A. sizes: each base runtime within 2 KB of the tree before stage 2 (9d25a00e), measured by the same generator
//      (`computeExportAssets`, the producer of dist/slide-export-assets.json). Fails on growth past that.
//   B. graph: no image module in a base bundle (beyond the allowed constants); no engine module in the image bundle
//      (it takes the few engine functions it calls from the base's `FluxSlideBase`, never a second copy).
//   C. documents: a deck / Paper document without images carries no image runtime; one with images carries it once;
//      the Paper live preview's CSP admits it.
// Run: npx tsx scripts/verify-slide-runtime-images.ts
import "./lib/cssStub.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import { computeExportAssets, exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { finishSlideDocument, slideDocumentBundle } from "../src/lib/slide/embedDocument";
import * as ops from "../src/lib/slide/ops";
import type { ExportPayload } from "../src/lib/slide/export/runtime";
import { assertNoEngineCode, assertNoImageCode, baseRuntimeSeams, imageHostNeeds, imageRuntimeSeams, IMAGE_RUNTIME_ENTRY } from "./runtime-seams.mjs";

const h = harness("verify-slide-runtime-images");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The base runtimes at 9d25a00e (before stage 2), by `computeExportAssets` (minified IIFE bytes). */
const OLD_TREE = { eager: 741_042, video: 733_183, embed: 736_725 } as const;
const SLACK = 2048;

h.section("A. the base runtimes are the size they were before images");
const assets = await computeExportAssets();
const bytes = (s?: string) => Buffer.byteLength(s ?? "");
const now = { eager: bytes(assets.runtime), video: bytes(assets.videoRuntime), embed: bytes(assets.embed?.runtime) };
for (const k of ["eager", "video", "embed"] as const)
  h.ok(now[k] > 0 && now[k] <= OLD_TREE[k] + SLACK, `${k} runtime ${now[k].toLocaleString("en")} B ≤ ${OLD_TREE[k].toLocaleString("en")} + ${SLACK} (before stage 2; ${now[k] - OLD_TREE[k] >= 0 ? "+" : ""}${now[k] - OLD_TREE[k]} B)`);
console.log(`  image runtime (only in documents with images): ${bytes(assets.fluximgRuntime).toLocaleString("en")} B`);

h.section("B. no image code in a base bundle, no engine code in the image bundle");
{
  const esbuild = await import("esbuild");
  const needs = await imageHostNeeds(esbuild, root);
  const opts = { absWorkingDir: root, bundle: true, write: false, metafile: true, platform: "browser" as const, minify: true, logLevel: "silent" as const,
    define: { "import.meta.env.DEV": "false" }, external: ["*/colormapLuts.gen"] };
  for (const [label, entry] of [["eager", "src/lib/slide/export/runtime.ts"], ["video", "src/lib/slide/export/videoRuntime.ts"], ["embed", "src/lib/slide/embedDocumentRuntime.ts"]]) {
    const r = await esbuild.build({ ...opts, entryPoints: [entry], format: "iife", plugins: [baseRuntimeSeams(needs)] });
    let err = "";
    try { assertNoImageCode(r.metafile!, label, root); } catch (e) { err = String((e as Error).message); }
    h.eq(err, "", `${label}: no image module in its bundle`);
  }
  const img = await esbuild.build({ ...opts, entryPoints: [IMAGE_RUNTIME_ENTRY], format: "iife", globalName: "FluxImageRuntime", plugins: [imageRuntimeSeams(needs)] });
  let err = "";
  try { assertNoEngineCode(img.metafile!, root); } catch (e) { err = String((e as Error).message); }
  h.eq(err, "", "image runtime: no engine module bundled a second time");
  const published = [...needs].map(([k, n]) => `${k.replace(/^src\/lib\//, "")}{${[...n].join(",")}}`).join(" ");
  console.log(`  the image kit takes from the base: ${published}`);
  // The seam is the only way in: a base bundle built WITHOUT it would carry the kit (so the swap is what keeps it out).
  const plain = await esbuild.build({ ...opts, entryPoints: ["src/lib/slide/export/runtime.ts"], format: "iife" });
  h.ok(Object.keys(Object.values(plain.metafile!.outputs)[0].inputs).some((p) => p.includes("slide/player/fluximg.ts")), "control: without the seam swap the eager bundle would hold the image player");
}

h.section("C. documents carry the image runtime only when they hold an image, and once");
{
  const deck = ops.createDeck({ id: "plain", title: "Plain" });
  ops.addSlideText(deck, deck.slides[0].id, { text: "Words", x: 60, y: 140, width: 500, height: 60, fontSize: 30 });
  const plain = await exportDeckHtml({ deck } as ExportPayload);
  const count = (html: string) => (html.match(/var FluxImageRuntimeFactory=/g) ?? []).length;
  h.eq(count(plain.html), 0, `a deck without images: no image runtime (${(plain.bytes / 1024).toFixed(0)} KB)`);
  h.ok(!plain.html.includes("slideFluximgClip") && !plain.html.includes("data-slide-fluximg"), "a deck without images: no image player code in its HTML");
  const withImage = { deck, images: { img: { manifest: { spec: "fluximg/1" } } } } as unknown as ExportPayload;
  const imaged = await exportDeckHtml(withImage);
  h.eq(count(imaged.html), 1, "a deck with an image: the image runtime exactly once");
  h.ok(imaged.html.indexOf("var FluxImageRuntimeFactory=") < imaged.html.indexOf("FluxSlideRuntime.boot("), "it is in place before the deck boots");

  const doc = async (payloads: Record<string, ExportPayload>) => {
    const bundle = { ...slideDocumentBundle(), payloads, occurrences: Object.keys(payloads).map((source, i) => ({ id: `s${i}`, source })), count: Object.keys(payloads).length };
    return (await finishSlideDocument(bundle, { interactive: true })).tail;
  };
  h.eq(count(await doc({ a: { deck } as ExportPayload })), 0, "a Paper document without images: no image runtime");
  h.eq(count(await doc({ a: { deck } as ExportPayload, b: withImage, c: withImage })), 1, "a Paper document with two image slides: the image runtime once");
  const image = JSON.parse(await readFile(path.join(root, ".generated/slide-embed-image-assets.json"), "utf8")).runtime as string;
  const csp = (await import(path.join(root, "electron/slideEmbedCsp.gen.cjs"))).default as string;
  h.ok(csp.includes(`'sha256-${createHash("sha256").update(image).digest("base64")}'`), "the Paper live preview's CSP admits the image runtime it inlines");
}

await h.done();
