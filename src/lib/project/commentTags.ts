// The tags you can attach to a margin comment, and their colours. Yours, not the project's: the
// list lives in the app's settings (there are none until you make one), and a comment stores
// only tag NAMES, so a tag someone else used still shows, in the neutral colour. Pure.
import { normalizeTag } from "./comments";

export interface CommentTagDef {
  /** Lower case, no "#": the form a comment stores. */
  name: string;
  /** #rrggbb; "" = no colour of its own (the comment highlight's). */
  color: string;
}

/** Colours offered for a new tag, in turn: the Flexoki accents, text-grade on paper. */
export const TAG_PALETTE = ["#bc5215", "#66800b", "#24837b", "#5e409d", "#a02f6f", "#ad8301", "#af3029", "#205ea6"] as const;
const HEX = /^#[0-9a-f]{6}$/;

/** Settings keep the list as plain strings, "name" or "name=#rrggbb". */
export function parseTagDefs(list: readonly string[]): CommentTagDef[] {
  const seen = new Set<string>(), out: CommentTagDef[] = [];
  for (const entry of list) {
    const [rawName, rawColor = ""] = String(entry).split("=");
    const name = normalizeTag(rawName), color = rawColor.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, color: HEX.test(color) ? color : "" });
  }
  return out;
}
export const formatTagDefs = (defs: readonly CommentTagDef[]): string[] => defs.map(d => d.color ? `${d.name}=${d.color}` : d.name);

/** The colour a tag is drawn in, or undefined when it has none of its own (or is not on the list). */
export const tagColor = (defs: readonly CommentTagDef[], name: string): string | undefined => defs.find(d => d.name === name)?.color || undefined;

/** The list with `name` on it. A new tag takes the first palette colour no tag is using yet. */
export function withTag(defs: readonly CommentTagDef[], raw: string, color?: string): CommentTagDef[] {
  const name = normalizeTag(raw);
  if (!name) return [...defs];
  const picked = color !== undefined ? (HEX.test(color.toLowerCase()) ? color.toLowerCase() : "") : undefined;
  if (defs.some(d => d.name === name)) return defs.map(d => d.name === name && picked !== undefined ? { ...d, color: picked } : d);
  const used = new Set(defs.map(d => d.color));
  return [...defs, { name, color: picked ?? TAG_PALETTE.find(c => !used.has(c)) ?? TAG_PALETTE[defs.length % TAG_PALETTE.length] }];
}
export const withoutTag = (defs: readonly CommentTagDef[], name: string): CommentTagDef[] => defs.filter(d => d.name !== name);

/** A comment's highlight colour: its first tag that has one, else undefined (the setting's). */
export function commentColor(defs: readonly CommentTagDef[], tags: readonly string[] | undefined): string | undefined {
  for (const tag of tags ?? []) { const color = tagColor(defs, tag); if (color) return color; }
  return undefined;
}
