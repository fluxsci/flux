export interface FontRequest { family: string; weight?: number; style?: string }
export function parseFamilyStack(stack: string): string[];
export function fontRequestKey(req: FontRequest): string;
