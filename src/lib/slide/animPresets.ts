// ---------------------------------------------------------------------------
// Flux Slide — the animation preset/template LIBRARY client (rework §7).
// Machine-global storage behind the animlib:* IPC trio:
//   <FluxConfig>/presets/animations/**.json      (presets)
//   <FluxConfig>/presets/anim-templates/**.json  (templates)
// The dev fixture's memBridge twins back the same surface with localStorage,
// so the picker + save flows verify headless. Payloads are validated on read
// (files are user-editable — a malformed one is skipped, never fatal).
// ---------------------------------------------------------------------------

import { fileBridge } from "../project/types";
import {
  parseAnimPreset,
  parseAnimTemplate,
  type AnimPreset,
  type AnimTemplate,
} from "./animTemplates";

export interface AnimLibEntry<T> {
  rel: string;
  payload: T;
}

function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (s || "preset").slice(0, 60);
}

export async function listAnimPresets(): Promise<AnimLibEntry<AnimPreset>[]> {
  const fig = fileBridge();
  const raw = (await fig?.readAnimLibrary?.("preset")) ?? [];
  const out: AnimLibEntry<AnimPreset>[] = [];
  for (const e of raw as { rel?: string; payload?: unknown }[]) {
    const p = parseAnimPreset(e?.payload);
    if (p && typeof e.rel === "string") out.push({ rel: e.rel, payload: p });
  }
  return out.sort((a, b) => a.payload.name.localeCompare(b.payload.name));
}

export async function listAnimTemplates(): Promise<AnimLibEntry<AnimTemplate>[]> {
  const fig = fileBridge();
  const raw = (await fig?.readAnimLibrary?.("template")) ?? [];
  const out: AnimLibEntry<AnimTemplate>[] = [];
  for (const e of raw as { rel?: string; payload?: unknown }[]) {
    const t = parseAnimTemplate(e?.payload);
    if (t && typeof e.rel === "string") out.push({ rel: e.rel, payload: t });
  }
  return out.sort((a, b) => a.payload.name.localeCompare(b.payload.name));
}

export async function saveAnimPreset(preset: AnimPreset): Promise<boolean> {
  const fig = fileBridge();
  return (await fig?.writeAnimLibrary?.("preset", `${slug(preset.name)}.json`, preset)) ?? false;
}

export async function saveAnimTemplate(template: AnimTemplate): Promise<boolean> {
  const fig = fileBridge();
  return (await fig?.writeAnimLibrary?.("template", `${slug(template.name)}.json`, template)) ?? false;
}

export async function deleteAnimEntry(kind: "preset" | "template", rel: string): Promise<boolean> {
  const fig = fileBridge();
  return (await fig?.deleteAnimLibrary?.(kind, rel)) ?? false;
}
