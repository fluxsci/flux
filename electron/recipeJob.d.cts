export function withRecipeLease<T>(path: string, fn: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T>;
export function readRecipeText(path: string): Promise<string>;
export function snapshotRecipe(path: string, text: string): Promise<string>;
export function discardRecipeSnapshot(path: string): Promise<void>;
