// flux-core/annotate.ts — FluxReader annotations (Node side: CLI/MCP/agents).
// Highlights/notes live in items/<citekey>/annotations.json (the filesystem is truth);
// anchored by quote (see src/lib/references/annotations.ts). The renderer twin is
// src/lib/references/annotationsBridge.ts. Library-wide search lets an agent "go
// research the comment I left in Tononi 2014".
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { resolveFluxLibPath } from "./fluxlib";
import { atomicWrite } from "./fsx";
import { annotationsPath, ITEMS_DIR } from "../src/lib/references/items";
import {
  emptyAnnotationFile,
  annotationMatches,
  type Annotation,
  type AnnotationFile,
} from "../src/lib/references/annotations";

async function lib(libPath?: string): Promise<string> {
  return libPath ? path.resolve(libPath) : await resolveFluxLibPath();
}

export async function loadAnnotations(key: string, libPath?: string): Promise<AnnotationFile> {
  try {
    return JSON.parse(await fs.readFile(annotationsPath(await lib(libPath), key), "utf8")) as AnnotationFile;
  } catch {
    return emptyAnnotationFile();
  }
}

export async function saveAnnotations(key: string, file: AnnotationFile, libPath?: string): Promise<void> {
  const p = annotationsPath(await lib(libPath), key);
  await atomicWrite(p, JSON.stringify(file, null, 2) + "\n");
}

export async function addAnnotation(
  key: string,
  a: Omit<Annotation, "id" | "createdAt"> & { id?: string; createdAt?: string },
  libPath?: string,
): Promise<Annotation> {
  const file = await loadAnnotations(key, libPath);
  const ann: Annotation = {
    id: a.id ?? crypto.randomUUID(),
    createdAt: a.createdAt ?? new Date().toISOString(),
    page: a.page,
    anchor: a.anchor,
    color: a.color,
    note: a.note,
    tags: a.tags,
  };
  file.annotations.push(ann);
  await saveAnnotations(key, file, libPath);
  return ann;
}

export async function deleteAnnotation(key: string, id: string, libPath?: string): Promise<void> {
  const file = await loadAnnotations(key, libPath);
  file.annotations = file.annotations.filter((x) => x.id !== id);
  await saveAnnotations(key, file, libPath);
}

export async function listAnnotations(key: string, libPath?: string): Promise<Annotation[]> {
  return (await loadAnnotations(key, libPath)).annotations;
}

/** Citekeys whose item dir has an annotations.json (the dir name = safeKey(citekey),
 *  identity for normal citekeys). */
async function keysWithAnnotations(L: string): Promise<string[]> {
  try {
    const dirs = await fs.readdir(path.join(L, ITEMS_DIR), { withFileTypes: true });
    const out: string[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      try {
        await fs.access(path.join(L, ITEMS_DIR, d.name, "annotations.json"));
        out.push(d.name);
      } catch {
        /* none */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface AnnotationHit extends Annotation {
  key: string;
}

/** Search annotations within one paper (key) or across the whole library. */
export async function searchAnnotations(
  query: string,
  opts: { key?: string; libPath?: string } = {},
): Promise<AnnotationHit[]> {
  const L = await lib(opts.libPath);
  const keys = opts.key ? [opts.key] : await keysWithAnnotations(L);
  const out: AnnotationHit[] = [];
  for (const k of keys) {
    for (const a of (await loadAnnotations(k, L)).annotations) {
      if (annotationMatches(a, query)) out.push({ ...a, key: k });
    }
  }
  return out;
}
