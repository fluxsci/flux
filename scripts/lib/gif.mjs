// Record a GIF of a headless interaction by capturing PNG frames and stitching
// them with ffmpeg (system binary). Used by the flux-figure enhancement verifiers
// to prove interactions are smooth/humane (drag-rotate, bend a node, scrub, …).
//
//   await recordGif(page, "f8-scrub", async (frame) => {
//     await page.mouse.move(x, y); await page.mouse.down();
//     for (…) { await page.mouse.move(...); await frame(); }
//     await page.mouse.up();
//   });
//
// `frame()` captures one screenshot; call it between interaction steps.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { OUT } from "./driver.mjs";

export async function recordGif(page, name, action, { fps = 20, width = 1000 } = {}) {
  const dir = path.join(OUT, `.frames-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let i = 0;
  const frame = async () => {
    await page.screenshot({ path: path.join(dir, `f-${String(i++).padStart(4, "0")}.png`) });
  };
  await action(frame);
  const out = path.join(OUT, `${name}.gif`);
  if (i === 0) throw new Error(`recordGif(${name}): no frames captured`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(dir, "f-%04d.png"),
      "-vf",
      `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
      out,
    ],
    { stdio: "ignore" },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
