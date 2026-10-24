// WP 1.8 live raster-keeper probe: the REAL exported player (real rAF clock) in OFFSCREEN Electron (BrowserWindow show:false; headless
// Chrome cannot see this defect class because its software raster re-rasterises every will-change layer). Nothing is shown and no dev
// server or port is used. Metric = gradient energy against a fresh render of the same pose/size (1.000 = exact).
//   node --import tsx scripts/perf/slide-raster-probe.mts          (exit 1 when a budget below is missed)
// Budgets (R4_T7_final §5.3): L1 bakes 0 at load / 1 after the beat, rest energy >= 0.995, hint ON throughout; L2 resize energy >= 0.995;
// L3 a scrub bakes 0 during and at the last seek, 1 at +500 ms; L4 bakes 1 at 10 000 and 29 000 nodes, 0 at 31 000 and 60 000;
// L5 a pan keeps will-change ["transform"]; L6 the first screenshot after `playing` turns false is already sharp;
// L7 a 29 000-node bake stalls rAF <= 34 ms. (L8, paint() cost on the slide-playback-profile dense deck, is `scripts/perf/slide-playback-profile.mjs`.)
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { exportDeckHtml } from "../../src/lib/slide/export/exportDeck";
import { cameraDeck, plainDeck } from "../lib/slideRasterDecks";

const require = createRequire(import.meta.url), repo = process.cwd();
const electron = require("electron") as string;
const out = await fs.mkdtemp(path.join(os.tmpdir(), "flux-raster-live-"));
const cam = cameraDeck(), plain = plainDeck();
const camHtml = path.join(out, "cam.html"), textHtml = path.join(out, "text.html");
await fs.writeFile(camHtml, (await exportDeckHtml({ deck: cam })).html); await fs.writeFile(textHtml, (await exportDeckHtml({ deck: plain })).html);
const job = { html: camHtml, htmlText: textHtml, out, zoom: cam.slides.findIndex((s) => s.id === "cam_zoom"), pan: cam.slides.findIndex((s) => s.id === "cam_pan"), still: plain.slides.findIndex((s) => s.id === "txt_static") };
const env: NodeJS.ProcessEnv = { ...process.env, FLUX_RASTER_LIVE: JSON.stringify(job) }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const args = [path.join(repo, "scripts/lib/slideRasterLiveEntry.cjs"), ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []), ...(env.FLUX_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])];
await new Promise<void>((resolve, reject) => {
  const child = spawn(electron, args, { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] }); let o = "", e = "";
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("live harness timed out")); }, 300000);
  child.stdout.on("data", (b) => { o += b; }); child.stderr.on("data", (b) => { e += b; });
  child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`live harness exit ${code}\n${(o + e).slice(-3000)}`)); });
});
const res = JSON.parse(await fs.readFile(path.join(out, "live.json"), "utf8"));
async function energy(name: string): Promise<number> {
  const img = await loadImage(await fs.readFile(path.join(out, `${name}.png`))), cv = createCanvas(img.width, img.height), c = cv.getContext("2d"); c.drawImage(img, 0, 0);
  const d = c.getImageData(0, 0, img.width, img.height).data, l = (i: number) => (d[4 * i] * 299 + d[4 * i + 1] * 587 + d[4 * i + 2] * 114) / 1000; let sum = 0;
  for (let y = 0; y < img.height - 1; y++) for (let x = 0; x < img.width - 1; x++) { const i = y * img.width + x, gx = l(i + 1) - l(i), gy = l(i + img.width) - l(i); sum += gx * gx + gy * gy; }
  return sum;
}
const failures: string[] = [], check = (ok: boolean, label: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failures.push(label); };
const eFresh = await energy("land_fresh"), eRest = (await energy("land_rest")) / eFresh, eFirst = (await energy("land_first")) / eFresh;
check(res.landing.atLoad === 0 && res.landing.afterBeat === 1, `L1 bakes ${res.landing.atLoad} at load, ${res.landing.afterBeat} after the beat (want 0 / 1)`);
check(eRest >= 0.995, `L1 rest energy vs a fresh page ${eRest.toFixed(3)} (want >= 0.995; HEAD 0.37)`);
check(res.landing.hints.length === 1 && res.landing.hints[0] === "transform", `L1 camera hint values ${JSON.stringify(res.landing.hints)} (want ["transform"] throughout)`);
check(eFirst >= 0.995, `L6 first screenshot after playing turned false: energy ${eFirst.toFixed(3)} (want >= 0.995; the R2 debounce design was >= 330 ms late)`);
const eResize = (await energy("resize_final")) / (await energy("resize_fresh"));
check(eResize >= 0.995, `L2 800x450 -> 1000 -> 1400 -> 1920x1080: energy vs a fresh page ${eResize.toFixed(3)} (want >= 0.995; HEAD 0.30)`);
check(res.scrub.before === 0 && res.scrub.during.every((n: number) => n === 0) && res.scrub.atLast === 0 && res.scrub.after500 === 1, `L3 scrub bakes ${JSON.stringify(res.scrub)} (want 0 during and at the last seek, 1 at +500 ms)`);
for (const [n, want] of [[10000, 1], [29000, 1], [31000, 0], [60000, 0]] as const) check(res.ceiling[n].bakes === want, `L4 ${n} injected nodes (${res.ceiling[n].nodes} under the camera): bakes ${res.ceiling[n].bakes} (want ${want})`);
check(res.stall.bakes === 1 && res.stall.maxGapMs <= 34 && res.stall.gapsOver34 === 0, `L7 29 000-node bake: max rAF gap ${res.stall.maxGapMs.toFixed(1)} ms, ${res.stall.gapsOver34} gaps > 34 ms, bakes ${res.stall.bakes} (want <= 34 ms, 0, 1)`);
check(res.pan.hints.length === 1 && res.pan.hints[0] === "transform", `L5 pan-only will-change values ${JSON.stringify(res.pan.hints)}, bakes ${res.pan.bakes} (want ["transform"]; HEAD ["transform",""])`);
const eRewind = (await energy("rewind_land")) / (await energy("rewind_rest"));
check(eRewind >= 0.995, `L8 the rewind's landing frame is as sharp as the frame at rest: energy ${eRewind.toFixed(3)} (want >= 0.995: no sharpening on a still frame)`);
check(res.rewind.sawReverse && res.rewind.atLanding === res.rewind.after500 && res.rewind.atLanding > res.rewind.before, `L8 Back after the zoom: bakes ${res.rewind.before} before, ${res.rewind.atLanding} at the landing, ${res.rewind.after500} 500 ms later (want: the re-bake before the landing, none after)`);
await fs.rm(out, { recursive: true, force: true });
if (failures.length) { console.error(`${failures.length} budget(s) missed`); process.exit(1); }
console.log("slide-raster-probe: all budgets met");
