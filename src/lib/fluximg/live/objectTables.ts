/**
 * The tables of object layers, loaded once per bundle and shared by everything that names an object: the layers
 * card on the board and the card that follows the pointer over the image.
 */
import { get, writable } from "svelte/store";
import type { Asset } from "../../types";
import { fluximgBundle, fluximgService } from "../store";
import type { FluximgTable } from "../types";

/** `<asset id>|<table path>` → the table, or null while it loads (or when it cannot be read). */
export const fluximgTables = writable<Record<string, FluximgTable | null>>({});

const keyOf = (asset: Pick<Asset, "id">, path: string): string => `${asset.id}|${path}`;
/** The store key of a table (`<asset id>|<path>`), or "" without a path. */
export const tableKey = (asset: Pick<Asset, "id">, path: string | null | undefined): string => (path ? keyOf(asset, path) : "");
/** Tables that could not be read, by store key, with why: a styled layer then draws unstyled and says so. */
export const fluximgTableIssues = writable<Record<string, string>>({});

/** Ask for a table; the store fills in when it arrives. Asking again is free. */
export function needTable(asset: Pick<Asset, "id" | "path">, path: string | null | undefined): void {
  if (!path) return;
  const key = keyOf(asset, path);
  if (key in get(fluximgTables)) return;
  fluximgTables.update((t) => ({ ...t, [key]: null }));
  void fluximgService().table(fluximgBundle(asset), path).then(
    (table) => fluximgTables.update((t) => ({ ...t, [key]: table })),
    (error: unknown) => fluximgTableIssues.update((m) => ({ ...m, [key]: error instanceof Error ? error.message : String(error) })),
  );
}

/** The table, if it has arrived. */
export const tableOf = (tables: Record<string, FluximgTable | null>, asset: Pick<Asset, "id">, path: string | null | undefined): FluximgTable | null => (path ? tables[keyOf(asset, path)] ?? null : null);

/** A table value as the board prints it. */
export const cellText = (v: unknown): string => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)))) : v === null || v === undefined ? "–" : String(v));

/** One object's row as name / value pairs (without the key column and the label column). */
export function objectCells(table: FluximgTable | null, key: string): Array<[string, string]> {
  if (!table) return [];
  const col = table.columns[table.key];
  if (!col) return [];
  // A null key names no object; of two rows with one key the first is the object's (as objectStyle reads it).
  const r = col.findIndex((v) => v !== null && v !== undefined && String(v) === key);
  if (r < 0) return [];
  return Object.keys(table.columns).filter((c) => c !== table.key && c !== "label").map((c) => [c, cellText(table.columns[c][r])]);
}
