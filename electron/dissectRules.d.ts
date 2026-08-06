// Type surface of electron/dissectRules.js. Keep in sync with its exports.

/** What a file inside a dissection folder is, for the viewer. */
export type DissectFileKind = "image" | "table" | "sidecar" | "other";

export const DISSECT_DIRNAME: string;
export const DISSECT_REL: string;
export const DISSECT_IMAGE_RE: RegExp;
export const DISSECT_TABLE_RE: RegExp;
export function isDissectDirName(name: string): boolean;
export function isDissectionProjectRel(rel: string): boolean;
export function isDissectionPlotsRel(rel: string): boolean;
/** Every source.svgPath shape (absolute / project-relative / bare name) → the plot's
 *  dissection KEY (plots/-relative path sans extension), or "" when nothing usable. */
export function plotKeyFor(sourcePath: string, projectRoot: string): string;
/** Key → the plots/-relative dissection root (`_dissections/<key>`). */
export function dissectionRootRelFor(key: string): string;
export function classifyDissectionFile(name: string): DissectFileKind;
