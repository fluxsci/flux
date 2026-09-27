// dist/flux-connect-hook.mjs: `flux connect --hook-delta` from the launcher.
// Quiet cases exit here; a change hands the session to the core CLI beside
// this file (process.argv is unchanged: `connect --hook-delta`).
import { hookFastPath } from "./hookFast";

const r = await hookFastPath().catch(() => "quiet" as const);
if (r !== "quiet") {
  process.env.FLUX_HOOK_SESSION = r.key;
  const core = "./flux-cli-core.mjs";
  await import(core);
}
