// Type surface of electron/fluxPaths.cjs for the TypeScript consumers
// (flux-core/fluxlib.ts, verify scripts). Keep in sync with the .cjs exports.

/** Machine config dir — lowercase "flux" on every platform. */
export function userDataDir(platform?: NodeJS.Platform): string;

/** Legacy capital-F dir — migration source only, never write here. */
export function legacyUserDataDir(platform?: NodeJS.Platform): string;
