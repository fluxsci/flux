// Type surface of electron/execResolve.cjs for the TypeScript consumers
// (flux-core, verify scripts). Keep in sync with the .cjs exports.

export interface ResolveSpawnOpts {
  /** Injectable for the pure gate; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injectable for the pure gate; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injectable for the pure gate; defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
}

export interface ResolvedSpawn {
  command: string;
  args: string[];
  /** true only for a win32 batch (.cmd/.bat) wrap — spread into spawn options. */
  windowsVerbatimArguments?: boolean;
}

export interface ResolvedPtySpawn {
  command: string;
  /** A single verbatim command-line string for a win32 batch wrap. */
  args: string[] | string;
}

/** Identity off win32; on win32 resolves PATH × PATHEXT, wrapping batch shims in ComSpec. */
export function resolveSpawn(command: string, args?: string[], o?: ResolveSpawnOpts): ResolvedSpawn;

/** node-pty flavor of resolveSpawn (batch wrap → string command line). */
export function resolvePtySpawn(
  command: string,
  args?: string[],
  o?: ResolveSpawnOpts,
): ResolvedPtySpawn;
