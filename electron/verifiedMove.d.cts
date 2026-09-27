export function createVerifiedMove(deps?: {fs?: any; fsp?: any; path?: any}): (source: string, destination: string, expectedSha256?: string) => Promise<string>;
