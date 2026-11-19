export function recipeTrustKey(recipePath: string): string;
export function isRecipeRootTrusted(prefs: unknown, key: string): boolean;
export function withTrustedRecipeRoot<T extends object>(prefs: T, key: string): T & { trustedRecipeRoots?: string[] };
export function recipeCommandLine(invocation: { executable: string; argv?: string[] }): string;
