#!/usr/bin/env -S npx tsx
// The portable HTML player, with an actual decoded clip and real input. No dev server.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { Slide } from "../src/lib/slide/types";
import { build } from "esbuild";
const { launch } = await import("./lib/driver.mjs");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-media-browser-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
let checks = 0;
function check(value: unknown, label: string) { assert.ok(value, label); checks++; console.log(`  ok: ${label}`); }
try {
  const deck = createDeck({ withTitleSlide: false }); deck.defaults.transition = "none";
  const slide: Slide = { id: "media", elements: [{ id: "clip", type: "video", assetId: "movie", posterAssetId: "poster", durationMs: 1200, loop: true, x: 40, y: 50, width: 160, height: 90, rotation: 0 }], beats: [
    { id: "base", tracks: [] },
    { id: "appear", tracks: [{ target: "clip", preset: "fade", duration: 150, easing: "linear" }] },
    { id: "start", tracks: [{ target: "clip", preset: "videoStart" }] },
    { id: "move", tracks: [{ target: "clip", preset: "transform", duration: 400, easing: "linear", to: { state: { x: 80, width: 320, height: 180 } } }] },
    { id: "pause", tracks: [{ target: "clip", preset: "videoPause" }] },
    { id: "restart", tracks: [{ target: "clip", preset: "videoStart" }] },
    { id: "stop", tracks: [{ target: "clip", preset: "videoStop" }] },
  ] };
  deck.slides = [slide, { id: "other", elements: [], beats: [{ id: "base", tracks: [] }] }];
  const movie = await fs.readFile(new URL("./fixtures/slide-video-clips/moving-box.mp4", import.meta.url));
  const poster = await fs.readFile(new URL("./fixtures/slide-video-clips/poster.png", import.meta.url));
  const payload = { deck, videos: { movie: `data:video/mp4;base64,${movie.toString("base64")}` }, assets: { poster: `data:image/png;base64,${poster.toString("base64")}` } };
  const { html } = await exportDeckHtml(payload); const out = path.join(tmp, "talk.html"); await fs.writeFile(out, html);
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(pathToFileURL(out).href); await page.waitForFunction("!!window.fluxDeck?.readyMedia");
  await page.evaluate("window.fluxDeck.readyMedia()");
  const inspect = () => page.evaluate(`(() => { const video = document.querySelector('video[data-slide-video]'); const wrapper = video.closest('[data-el-id]'); const effects = wrapper.querySelector('.sl-effects'); return {currentTime:video.currentTime,paused:video.paused,muted:video.muted,loop:video.loop,width:wrapper.style.width,left:wrapper.style.left,opacity:Number(getComputedStyle(effects||wrapper).opacity),state:window.fluxDeck.state()}; })()`);
  let current = await inspect();
  check(current.paused && current.currentTime === 0 && current.opacity === 0 && !current.muted, "initial poster remains silent and hidden before its appearance");
  await page.keyboard.press("ArrowRight"); await page.waitForFunction("window.fluxDeck.state().beat===1&&!window.fluxDeck.state().playing");
  current = await inspect(); check(current.paused && current.currentTime === 0 && current.opacity === 1, "Appear displays the poster without starting its clip");
  await page.keyboard.press("ArrowRight"); await page.waitForFunction("window.fluxDeck.state().mediaPlaying&&document.querySelector('video').currentTime>.12");
  current = await inspect(); check(!current.paused && !current.state.playing && current.state.mediaPlaying, "Start plays native video after the zero-duration animation cue finishes");
  await page.evaluate("window.savedVideoNode=document.querySelector('video')");
  await page.keyboard.press("ArrowRight"); await page.waitForFunction("window.fluxDeck.state().beat===3&&window.fluxDeck.state().time>100");
  check(await page.evaluate("window.savedVideoNode===document.querySelector('video')&&!window.savedVideoNode.paused"), "geometry Changes preserve the playing decoder's identity");
  await page.waitForFunction("!window.fluxDeck.state().playing");
  current = await inspect(); check(current.width === "320px" && current.left === "80px" && current.state.mediaPlaying, "video completes its smooth geometry Change and keeps playing");
  await page.evaluate("window.fluxDeck.pause()"); const paused = await inspect();
  await page.evaluate("new Promise(resolve=>{let n=0;const frame=()=>++n===8?resolve():requestAnimationFrame(frame);requestAnimationFrame(frame);})");
  current = await inspect(); check(current.paused && current.state.mediaPaused && Math.abs(current.currentTime - paused.currentTime) < .002, "Pause freezes video even after the animation clock has stopped");
  await page.evaluate("window.fluxDeck.resume()"); await page.waitForFunction("window.fluxDeck.state().mediaPlaying");
  check(!(await inspect()).paused, "Resume restores native playback");
  await page.keyboard.press("b"); check((await inspect()).paused, "presentation blank pauses video and sound");
  await page.keyboard.press("b"); await page.waitForFunction("window.fluxDeck.state().mediaPlaying");
  await page.keyboard.press("ArrowRight"); current = await inspect(); check(current.paused && !current.state.mediaPlaying, "a separately authored Pause command freezes playback");
  await page.keyboard.press("ArrowRight"); await page.waitForFunction("window.fluxDeck.state().mediaPlaying");
  check((await inspect()).currentTime < .2, "a new Start command restarts from the first frame");
  await page.keyboard.press("ArrowRight"); await page.evaluate("window.fluxDeck.readyMedia()");
  current = await inspect(); check(current.paused && current.currentTime === 0, "Stop resets the clip to its first frame");
  await page.evaluate("window.fluxDeck.seek(0,3,250)"); await page.evaluate("window.fluxDeck.readyMedia()");
  current = await inspect(); check(current.paused && Math.abs(current.currentTime - .25) < .002, "random seek addresses the clip's exact presentation time");
  const redLeft = await page.evaluate(`(() => {const video=document.querySelector('video');const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,160,90);const p=ctx.getImageData(0,40,160,1).data;for(let x=0;x<160;x++)if(p[x*4]>160&&p[x*4+1]<100&&p[x*4+2]<100)return x;return -1;})()`);
  check(redLeft >= 37 && redLeft <= 41, `decoded seek frame paints the expected moving square (${redLeft}px)`);
  await page.evaluate("window.fluxDeck.goTo(0,1)"); await page.evaluate("window.fluxDeck.readyMedia()");
  current = await inspect(); check(current.currentTime === 0 && current.paused && current.opacity === 1, "reverse navigation restores the pre-Start poster");
  check(await page.evaluate("window.savedVideoNode===document.querySelector('video')"), "scrub and reverse keep the same retained decoder");
  await page.evaluate("window.fluxDeck.goTo(1,0)");
  check(await page.evaluate("window.savedVideoNode.paused&&!window.savedVideoNode.getAttribute('src')&&!document.querySelector('video')"), "leaving the slide releases video source and decoder");
  const embedCode = await build({ stdin: { contents: 'export {mountSlideEmbed} from "./src/lib/slide/embedPlayer";', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "EmbedTest", platform: "browser" });
  const embedFile = path.join(tmp, "embed.html");
  await fs.writeFile(embedFile, `<style>body{margin:0}.flux-slide-art{height:360px}.flux-slide-fit{transform-origin:0 0}</style><div id="one" style="width:640px"></div><div id="two" style="width:640px"></div><script>${embedCode.outputFiles[0].text}</script>`);
  await page.goto(pathToFileURL(embedFile).href);
  await page.evaluate(payload => {
    const runtime = (window as unknown as { EmbedTest: { mountSlideEmbed: Function }; firstEmbed: unknown; secondEmbed: unknown });
    runtime.firstEmbed = runtime.EmbedTest.mountSlideEmbed(document.getElementById("one"), payload);
    runtime.secondEmbed = runtime.EmbedTest.mountSlideEmbed(document.getElementById("two"), payload, { state: { beatId: "base", reduced: true } });
  }, { ...payload, deck: { ...deck, slides: [slide] } });
  await page.evaluate("Promise.all([window.firstEmbed.player.readyMedia(),window.secondEmbed.player.readyMedia()])");
  await page.evaluate("window.firstEmbed.player.play({slide:0,fromBeat:2,toBeat:2})");
  await page.waitForFunction("window.firstEmbed.player.state().mediaPlaying");
  check(await page.evaluate("document.querySelector('#two video').paused&&document.querySelector('#two video').currentTime===0"), "repeated inline slide occurrences have independent video clocks");
  await page.click('#two button[aria-label="Next animation step"]');
  check(await page.evaluate("!window.secondEmbed.player.state().playing&&document.querySelector('#two video').paused"), "reduced-motion inline appearance reveals a paused poster immediately");
  await page.click('#two button[aria-label="Next animation step"]');
  await page.waitForFunction("window.secondEmbed.player.state().mediaPlaying");
  check(await page.evaluate("!document.querySelector('#two video').paused"), "an explicit Start still plays video when visual animation is reduced");
  await page.evaluate("window.firstEmbed.pauseOffscreen()");
  check(await page.evaluate("document.querySelector('#one video').paused&&window.firstEmbed.player.state().mediaPaused"), "inline offscreen disposal pauses clips after the animation clock ends");
  const resumeButton = await page.$('#one button[aria-label="Pause or resume video clips"]'); assert.ok(resumeButton);
  await resumeButton.click(); await page.waitForFunction("window.firstEmbed.player.state().mediaPlaying");
  check(await page.evaluate("!document.querySelector('#one video').paused"), "inline transport explicitly resumes an offscreen-paused clip");
  await page.evaluate("window.savedEmbedVideo=document.querySelector('#one video');window.firstEmbed.destroy();window.secondEmbed.destroy()");
  check(await page.evaluate("window.savedEmbedVideo.paused&&!window.savedEmbedVideo.getAttribute('src')&&!document.querySelector('video')"), "inline teardown releases all clip decoders and source references");
  check(errors.length === 0, `portable clip playback has a clean console: ${errors.join("; ")}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
console.log(`\nSLIDE MEDIA BROWSER: PASS (${checks} assertions)`);
