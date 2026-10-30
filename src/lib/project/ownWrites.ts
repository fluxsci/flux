/** Recent publications, validated by file identity rather than a time-only
 * ignore window: an external rewrite of the same path must still reload. */
export interface WriteStat { size: number; mtimeMs: number; ctimeMs?: number; ino?: number }
export class OwnWriteMatcher {
  private writes = new Map<string, { stat: WriteStat | null; expires: number }>();
  constructor(private now: () => number = Date.now) {}
  private prune() {
    const now = this.now();
    for (const [path, entry] of this.writes) if (entry.expires <= now) this.writes.delete(path);
  }
  record(path: string, stat: WriteStat | null): void {
    this.prune();
    this.writes.set(path.replace(/\\/g, "/"), { stat: stat && { ...stat }, expires: this.now() + 5000 });
  }
  forgetUnder(prefix: string): void {
    const normalized = prefix.replace(/\\/g, "/");
    for (const path of this.writes.keys()) if (path.startsWith(normalized)) this.writes.delete(path);
  }
  has(path: string): boolean { this.prune(); return this.writes.has(path.replace(/\\/g, "/")); }
  matches(path: string, stat: WriteStat | null): boolean {
    this.prune();
    const entry = this.writes.get(path.replace(/\\/g, "/"));
    if (!entry) return false;
    if (entry.stat === null || stat === null) return entry.stat === stat;
    return entry.stat.size === stat.size && entry.stat.mtimeMs === stat.mtimeMs &&
      entry.stat.ctimeMs === stat.ctimeMs && entry.stat.ino === stat.ino;
  }
}
