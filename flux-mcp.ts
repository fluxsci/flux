#!/usr/bin/env -S npx tsx
// Compatibility entry for npm run flux:mcp and existing server registrations.
import { startMcpServer } from "./flux-core/mcpServer";
await startMcpServer({ root: process.argv[2] });
