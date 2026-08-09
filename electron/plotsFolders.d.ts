// Type surface of electron/plotsFolders.js. Keep in sync with its exports.

/** A reserved folder under plots/, with the one-line description the importer shows. */
export interface ReservedPlotFolder {
  name: string;
  hint: string;
}

export const LIGHTTABLE_DIRNAME: string;
export const LIGHTTABLE_REL: string;
export const RESERVED_PLOT_FOLDERS: ReservedPlotFolder[];
export const RESERVED_PLOT_DIRNAMES: string[];
/** Name-exact: is this directory entry one of the reserved folders? */
export function isReservedPlotDirName(name: string): boolean;
/** Segment-exact: is this PROJECT-relative path inside plots/_lighttable/? */
export function isLighttableProjectRel(rel: string): boolean;
/** The reserved folder a plots/-relative path sits under (bare name), or "". */
export function reservedRootOfPlotsRel(rel: string): string;
