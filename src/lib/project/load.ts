// Read + lightly validate a project from disk.

import {
  PROJECT_SCHEMA_VERSION,
  fileBridge,
  joinPath,
  type LoadedProject,
  type ProjectManifest,
} from "./types";

export class NotAProjectError extends Error {}

export async function loadProject(root: string): Promise<LoadedProject> {
  const fig = fileBridge();
  if (!fig) throw new Error("No file bridge available (not running in the app).");

  const manifestPath = joinPath(root, "project.json");
  if (!(await fig.exists(manifestPath))) {
    throw new NotAProjectError("No project.json — not a Flux project.");
  }

  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(await fig.readText(manifestPath)) as ProjectManifest;
  } catch {
    throw new Error("project.json is not valid JSON.");
  }

  if (manifest.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    // Tolerant for now (forward-migration lands later); just note it.
    console.warn(
      `Project schemaVersion ${manifest.schemaVersion} != ${PROJECT_SCHEMA_VERSION}`,
    );
  }

  return { root, manifest };
}

/**
 * Read a document's text for a loaded project (empty string if missing).
 * `relPath` defaults to the main manuscript; pass a sibling .qmd for F4 multi-doc.
 */
export async function readManuscript(p: LoadedProject, relPath?: string): Promise<string> {
  const fig = fileBridge();
  if (!fig) return "";
  const path = joinPath(p.root, relPath ?? p.manifest.manuscript.path);
  try {
    if (await fig.exists(path)) return await fig.readText(path);
  } catch {
    /* ignore */
  }
  return "";
}

export async function writeManuscript(
  p: LoadedProject,
  text: string,
  relPath?: string,
): Promise<void> {
  const fig = fileBridge();
  if (!fig) return;
  const rel = relPath ?? p.manifest.manuscript.path;
  await fig.writeText(joinPath(p.root, rel), text);
  // WS6: provenance for the human's manuscript save (Electron only).
  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "set_manuscript", target: rel, client: "human" });
}
