// CLI-only mutations live outside the verb registry. MCP exposes only doctor.
import { createInterface } from 'node:readline/promises';
import * as setup from '../electron/agentSetup.cjs';
export { probeAgents, planSetup, applySetup, planRemove, applyRemove, publishUserSkills, doctor } from '../electron/agentSetup.cjs';

export interface ReceiptCheck { packId: string; proof: string | string[] }
/** The pack's own codes decide: which bundle sections and images the proof line confirms. */
async function checkPackReceipt(request: ReceiptCheck) {
  const { checkPackReceipt: check } = await import('./connect/index');
  return check(request.packId, Array.isArray(request.proof) ? request.proof.join(' ') : request.proof);
}

export async function connectDoctor(options: { checkReceipt?: ReceiptCheck } = {}, dependencies: {
  checkReceipt?: (request: ReceiptCheck) => unknown | Promise<unknown>;
} = {}) {
  const checks = await setup.doctor();
  const receipt = options.checkReceipt ? await (dependencies.checkReceipt ?? checkPackReceipt)(options.checkReceipt) : undefined;
  return { checks, ...(receipt === undefined ? {} : { receipt }) };
}

export async function runAgentSetupCli(argv: string[]) {
  const [command, ...args] = argv;
  const flags = new Map<string, string | boolean>();
  const allowed = command === 'setup' ? ['agents', 'yes', 'dry-run', 'create-local-bin', 'use-this-install', 'help']
    : command === 'remove' ? ['agents', 'yes', 'help'] : ['json', 'help'];
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!match || !allowed.includes(match[1])) throw new Error(`Unknown ${command} option: ${args[i]}`);
    const key = match[1];
    if (flags.has(key)) throw new Error(`Repeated --${key}`);
    if (key === 'agents') {
      const value = match[2] ?? args[++i];
      if (!value || value.startsWith('--')) throw new Error('--agents needs claude,codex');
      flags.set(key, value);
    } else {
      if (match[2] !== undefined) throw new Error(`--${key} takes no value`);
      flags.set(key, true);
    }
  }
  if (flags.has('help')) {
    console.log('flux connect setup [--agents claude,codex] [--yes] [--dry-run] [--create-local-bin] [--use-this-install]\nflux connect doctor [--json]\nflux connect remove [--agents claude,codex] [--yes]'); return;
  }
  if (command === 'doctor') {
    const result = await connectDoctor();
    if (flags.has('json')) console.log(JSON.stringify(result, null, 2));
    else for (const c of result.checks) console.log(`${c.status.toUpperCase()} ${c.id}: ${c.message}${c.fix ? `\n  Fix: ${c.fix}` : ''}`);
    if (result.checks.some(c => c.status === 'fail')) process.exitCode = 1;
    return;
  }
  const probe = await setup.probeAgents();
  const options = { probe, agents: flags.get('agents') as string | undefined, createLocalBin: flags.has('create-local-bin'), useThisInstall: flags.has('use-this-install') };
  const plan = command === 'remove' ? setup.planRemove(options) : setup.planSetup(options);
  // Do not print unrelated vendor config values (which can contain credentials).
  console.log(JSON.stringify({ action: command, agents: plan.agents, launcher: plan.runtime?.cli,
    changes: plan.actions.map(a => ({ agent: a.agent, path: a.path, kind: a.kind, confirmation: !!a.confirmation })),
    checks: plan.checks, nextSteps: plan.nextSteps }, null, 2));
  if (flags.has('dry-run')) return;
  if (plan.checks.some(c => c.status === 'fail')) throw new Error('Setup has failed checks; no changes applied.');
  let yes = flags.has('yes');
  if (!yes && (command === 'remove' || plan.actions.some(a => a.confirmation))) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Review the plan, then pass --yes to confirm these changes.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { yes = /^(y|yes)$/i.test((await prompt.question('Apply the changes shown above? [y/N] ')).trim()); }
    finally { prompt.close(); }
    if (!yes) return;
  }
  const result = command === 'remove' ? await setup.applyRemove(plan, { yes }) : await setup.applySetup(plan, { yes });
  console.log(JSON.stringify(result, null, 2));
}
