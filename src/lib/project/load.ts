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

/** Read the manuscript text for a loaded project (empty string if missing). */
export async function readManuscript(p: LoadedProject): Promise<string> {
  const fig = fileBridge();
  if (!fig) return "";
  const path = joinPath(p.root, p.manifest.manuscript.path);
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
): Promise<void> {
  const fig = fileBridge();
  if (!fig) return;
  await fig.writeText(joinPath(p.root, p.manifest.manuscript.path), text);
}
