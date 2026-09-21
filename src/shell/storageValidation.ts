import type { RecentProject } from './shellStore';
/** Preferences are unknown input, never project/scientific data. */
export function decodeRecents(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rows: RecentProject[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string' || !row.name.trim() || !(row.path === null || typeof row.path === 'string' && row.path.trim()) || typeof row.openedAt !== 'number' || !Number.isFinite(row.openedAt) || row.openedAt < 0) continue;
    const key = row.path ?? `memory:${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key); rows.push({ name: row.name, path: row.path, openedAt: row.openedAt });
    if (rows.length === 8) break;
  }
  return rows;
}
export function finitePreference(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
