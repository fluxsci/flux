import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { load } from 'js-yaml';
import { harness } from './lib/harness.mjs';
import { agentFixture } from './lib/agentSetupFixture';
import { renderSkill, validateSkill } from '../electron/agentSetup.cjs';
const h = harness('verify-skill-template'), fixture = await agentFixture();
try {
  for (const agent of ['claude', 'codex'] as const) {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const cli = platform === 'win32' ? 'C:\\Users\\A User\\local\\flux\\bin\\flux.cmd' : '/home/a user/.local/share/flux/bin/flux';
      const result = renderSkill({ ...fixture.runtime, cli, platform }, agent);
      const source = result.files['SKILL.md'], meta = load(/^---\n([\s\S]*?)\n---/.exec(source)![1]) as Record<string, unknown>;
      h.eq(meta.name, 'flux-connect', `${agent}/${platform}: frontmatter name matches directory`);
      h.eq(meta['disable-model-invocation'], true, `${agent}/${platform}: explicit-only Claude frontmatter retained`);
      h.ok(typeof meta.description === 'string' && meta.description.includes('ONLY'), `${agent}/${platform}: explicit request description`);
      h.ok(source.includes(`"${cli.replaceAll('\\', platform === 'win32' ? '\\' : '\\\\')}" connect`), `${agent}/${platform}: absolute launcher is quoted`);
      h.ok(!/{{[A-Z_]+}}/.test(source), `${agent}/${platform}: every placeholder substituted`);
      if (agent === 'codex') {
        const yaml = load(result.files['agents/openai.yaml']) as { policy: { allow_implicit_invocation: boolean } };
        h.eq(yaml.policy.allow_implicit_invocation, false, 'Codex enforces explicit invocation through documented policy');
        h.ok(!('argument-hint' in meta), 'Codex rendering omits unverified Claude-only argument hint');
      } else h.ok(typeof meta['argument-hint'] === 'string', 'Claude argument hint remains');
    }
  }
  h.ok(!validateSkill('---\nname: stats\ndescription: >-\n  A folded\n  description\n---\nBody','stats').error, 'YAML folded descriptions parse');
  for (const [source, name] of [['---\nname: other\ndescription: x\n---','stats'], ['---\nname: stats\n---','stats'], ['---\nname: stats\ndescription: [oops\n---','stats'], ['text','stats'], ['---\nname: BAD\ndescription: x\n---','BAD']]) {
    h.ok(!!validateSkill(source,name).error, `Invalid skill rejected (${name})`);
  }
  h.ok(!await fs.stat(path.resolve('skills/flux')).catch(() => null), 'retired skill directory deleted');
} catch (e) { h.fail(String(e)); }
await h.done(fixture.cleanup);
