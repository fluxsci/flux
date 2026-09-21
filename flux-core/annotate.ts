import { itemKey } from "../src/lib/references/itemLocator";
import { prepareItemLocators } from "./itemLocators";
import { assertNoCanonicalConflict, readCanonicalText, parseCanonical, rememberCanonical, assertCanonicalSnapshot } from "../src/lib/references/canonical";
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
import { fluxlibLockDir, getLockClient, withLockAt, assertLockOwned } from "./locks";
import { annotationsPath, ITEMS_DIR, safeKey } from "../src/lib/references/items";
import {
  emptyAnnotationFile,
  validateAnnotations,
  annotationMatches,
  type Annotation,
  type AnnotationFile,
} from "../src/lib/references/annotations";

async function lib(libPath?: string): Promise<string> {
  const root = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  await prepareItemLocators(root);
  return root;
}

// Mutations are whole-file read-modify-writes; run them under the FluxLib lock the
// renderer bridge also takes (libLock.ts, name `annotations-<safeKey>`) so an agent
// write can't interleave with a human's highlight and lose it.
async function withAnnotationLock<T>(key: string, libPath: string | undefined, fn: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  return withLockAt(fluxlibLockDir(await lib(libPath)), `annotations-${safeKey(key)}`, getLockClient(), lease => fn(() => assertLockOwned(lease)), {
    retries: 4, // contending writes are ms-scale; a human-held lock still defers immediately
  });
}

export async function loadAnnotations(key: string, libPath?: string): Promise<AnnotationFile> {
  const p = annotationsPath(await lib(libPath), key);
  const text = await readCanonicalText(p, () => fs.readFile(p, "utf8"));
  return rememberCanonical(text === null ? emptyAnnotationFile() : parseCanonical(p, text, validateAnnotations), p, text);
}

export async function saveAnnotations(key: string, file: AnnotationFile, libPath?: string, assertOwned?: () => Promise<void>): Promise<void> {
  if (!assertOwned) return withAnnotationLock(key, libPath, guard => saveAnnotations(key, file, libPath, guard));
  const p = annotationsPath(await lib(libPath), key);
  await assertNoCanonicalConflict(p, dir=>fs.readdir(dir));
  await assertCanonicalSnapshot(file, p => readCanonicalText(p, () => fs.readFile(p, "utf8")));
  validateAnnotations(file);
  await assertOwned();
  await atomicWrite(p, JSON.stringify(file, null, 2) + "\n");
}

export async function addAnnotation(
  key: string,
  a: Omit<Annotation, "id" | "createdAt"> & { id?: string; createdAt?: string },
  libPath?: string,
): Promise<Annotation> {
  return withAnnotationLock(key, libPath, async assertOwned => {
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
    await saveAnnotations(key, file, libPath, assertOwned);
    return ann;
  });
}

export async function updateAnnotation(
  key: string,
  id: string,
  patch: Partial<Pick<Annotation, "note" | "tags" | "color">>,
  libPath?: string,
): Promise<Annotation | null> {
  return withAnnotationLock(key, libPath, async assertOwned => {
    const file = await loadAnnotations(key, libPath);
    const a = file.annotations.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, patch);
    await saveAnnotations(key, file, libPath, assertOwned);
    return a;
  });
}

export async function deleteAnnotation(key: string, id: string, libPath?: string): Promise<void> {
  return withAnnotationLock(key, libPath, async assertOwned => {
    const file = await loadAnnotations(key, libPath);
    file.annotations = file.annotations.filter((x) => x.id !== id);
    await saveAnnotations(key, file, libPath, assertOwned);
  });
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
        out.push(itemKey(L, d.name));
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
