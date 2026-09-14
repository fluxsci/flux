import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createSlideRepository } from "../src/lib/slide/embedRepository";
import { syncEmbeddedDeckSources } from "../src/lib/slide/embedSources";
import { syncFigureAssets } from "./figures";
import { exists } from "./model";
import { ensureDom } from "./render";
import { atomicWrite } from "./fsx";
import { withLock } from "./locks";
import { CLIENT } from "./journal";
/** Same repository and source policy as Paper, with durable Node IO. */
export async function nodeSlideRepository(root: string) {
  await ensureDom();
  const io = { exists, readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p),
    writeText: atomicWrite, mkdir: async (p: string) => { await fs.mkdir(p, { recursive: true }); }, remove: (p: string) => fs.rm(p, { force: true }) };
  let figures: Promise<string[]> | undefined;
  return createSlideRepository(root, { ...io,
    // Posters and PDF/Word need only the separate PNG. Interactive exports ask
    // the repository for portable materialization, which then embeds the clip.
    videoUrl: async file => { await fs.access(file); return pathToFileURL(file).href; },
    prepareDeck: async id => {
    figures ??= (async () => {
      if (!await exists(`${root}/fig/index.json`)) return [];
      const report = await syncFigureAssets(root);
      return [...report.warnings, ...report.missing.map(p => `${p}: source missing; last accepted source retained`)];
    })();
    const warnings = await figures;
    return [...warnings, ...await withLock(root, "slides", CLIENT, () => syncEmbeddedDeckSources(root, id, io))];
  } });
}
