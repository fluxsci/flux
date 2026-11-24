// The project's artifacts as the renderer knows them: one listing per window (both Paper panes
// read it), refreshed when the project opens, when the folder link changes and when the watcher
// says pages came or went. Which artifact a pane shows is that pane's own state (PaperMode).
import { get, writable } from "svelte/store";
import { fileBridge } from "../project/types";
import type { ArtifactListing, ArtifactsChanged } from "./types";

export const artifactListing = writable<ArtifactListing | null>(null);
/** The newest change the watcher reported; `n` makes two identical reports distinct. */
export const artifactChange = writable<(ArtifactsChanged & { n: number }) | null>(null);

let listedRoot: string | null = null;
let generation = 0;
let unwatch: (() => void) | null = null;
let changes = 0;

/** List `root`'s artifacts (null when artifacts are unavailable here). A newer call wins. */
export async function refreshArtifacts(root: string | null): Promise<ArtifactListing | null> {
  const mine = ++generation;
  const bridge = fileBridge();
  if (!root || !bridge?.artifactsList) {
    listedRoot = root;
    artifactListing.set(null);
    return null;
  }
  if (!unwatch && bridge.onArtifactsChanged) {
    unwatch = bridge.onArtifactsChanged((info) => {
      artifactChange.set({ paths: Array.isArray(info?.paths) ? info.paths : [], structure: info?.structure === true, n: ++changes });
      if (info?.structure && listedRoot) void refreshArtifacts(listedRoot);
    });
  }
  if (listedRoot !== root) artifactListing.set(null);
  listedRoot = root;
  try {
    const listing = await bridge.artifactsList(root);
    if (mine === generation) artifactListing.set(listing);
    return mine === generation ? listing : get(artifactListing);
  } catch {
    if (mine === generation) artifactListing.set(null);
    return null;
  }
}

/** Link a folder of artifacts to the project (null unlinks). Resolves to an error message, or "". */
export async function linkArtifactFolder(root: string, dir: string | null): Promise<string> {
  const bridge = fileBridge();
  if (!bridge?.artifactsSetDir) return "Linking a folder needs the desktop app.";
  try {
    const listing = await bridge.artifactsSetDir(root, dir);
    generation++;
    listedRoot = root;
    artifactListing.set(listing);
    return "";
  } catch (e) {
    return (e as Error).message || "Could not link that folder.";
  }
}

/** Ask for a folder and link it. Resolves to an error message, "" on success or when cancelled. */
export async function chooseArtifactFolder(root: string): Promise<string> {
  const bridge = fileBridge();
  if (!bridge?.openDirectory || !bridge.artifactsSetDir) return "Linking a folder needs the desktop app.";
  const dir = await bridge.openDirectory("Choose a folder of artifacts (HTML pages)");
  return dir ? linkArtifactFolder(root, dir) : "";
}
