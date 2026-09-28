// Compatibility entry point; the canonical generator owns every schema output.
import { tsImport } from 'tsx/esm/api';
const { generateFiles } = await tsImport('./gen-validators.mjs', import.meta.url);
await generateFiles(process.argv.includes('--check'));
