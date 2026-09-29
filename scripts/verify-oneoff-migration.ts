// Run only through: node scripts/run-verifies.mjs --tier pure --only oneoff-migration
// The migrator always runs in a plain-Node child with scratch HOME and cwd.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { harness } from './lib/harness.mjs';
import { TestProcessScope } from './lib/testProcess.mjs';
import { historicalMission, HISTORICAL_NOTEBOOK, HISTORICAL_AGENTS_STUB, HISTORICAL_GUIDES } from './oneoff/migrate-2026-09-flux-connect.mjs';

const h = harness('verify-oneoff-migration');
const scope = new TestProcessScope();
const script = fileURLToPath(new URL('./oneoff/migrate-2026-09-flux-connect.mjs', import.meta.url));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flux-oneoff-')));
const home = path.join(scratch, 'home');
const roots = path.join(scratch, 'projects');
const reports = path.join(scratch, 'reports');
for (const dir of [home, roots, reports]) fs.mkdirSync(dir);
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData', 'Roaming'), FLUX_NO_MIGRATE: '1' };
const oldPath = 'Context/Project/MISSION.qmd';
const newPath = 'Context/ProjectContext.qmd';
const archive = '.meta/archive/2026-09-agent-workflow';
const oldComment = HISTORICAL_NOTEBOOK.match(/<!--[\s\S]*?-->/)![0];
const oldInstruction = HISTORICAL_NOTEBOOK.split('\n').find((s: string) => s.startsWith('*(Append-only'))!;
// These expectations are independently copied from the approved plan, not the migrator.
const newComment = `<!-- The project's running log. Entries are added when you ask an agent to record one
     (or when you write one yourself). Every flux-connected agent reads it. -->`;
const newInstruction = '*(Append-only, newest last: `### YYYY-MM-DD HH:MM — title`, For each entry, note which agent you are and where you are working from (cli/vsCode/desktop app/etc.). Use as much detail as is appropriate for the entry you are making, which could be anything from a very concise sentence or two to a highly-detailed multi-paragraph or multi-page entry)*';
const newStub = `# This is a Flux project

This folder is managed by Flux, a scientific writing studio (documents, figures, slides,
references). To get fully up to speed on it, the user can flux-connect you:
\`/flux-connect <this folder>\` in Claude Code, \`$flux-connect <this folder>\` in Codex, or
\`flux-connect <this folder>\` in any shell. If the user asks for work on this project and you
are not connected, suggest it; do not connect unasked. Connecting loads a large amount of context.

Never hand-edit \`fig/**\` or \`.meta/**\`; use the Flux verbs (\`flux-connect\` prints how to run them).
`;
const newContext = (title: string) => `---
title: "Project context — ${title.replace(/"/g, '\\"')}"
---

<!-- What any agent working on this project must know. Every flux-connected agent reads this
     file AND every file it links (Markdown links, images, Quarto includes) — so rather than
     copying material in, link it: [analysis plan](../notes/plan.md), [data notes](/data/…/README.md).
     Keep it current; it is the single place to put "things the agent keeps missing". -->

## Background

## Goals or questions

*(If there is a clear mission, state it here. It is fine if there isn't one yet.)*

## Data and code

*(Where the data and analysis code live; environments.)*

## Key files and links

## Deliverables

*(Papers, talks, reports — if any.)*
`;
const archiveReadme = `# Retired Flux agent workflow — September 2026

These folders were moved here by migrate-2026-09-flux-connect.mjs:
Transcripts (agent session records), Dispatches (worker briefs and output), and
agent (local agent state formerly in .meta/agent). Contents and thread IDs are
preserved. The migration used filesystem rename, never copy. Flux no longer uses
these records; keep them for reference. This directory is ignored by Git.
`;
const ignore = '.meta/archive/\n.meta/feedback/\n.meta/live/\n';
function put(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function read(file: string) { return fs.readFileSync(file, 'utf8'); }
function project(name: string, base = roots) {
  const root = path.join(base, name);
  put(path.join(root, 'project.json'), `{"title":${JSON.stringify(name)},"documentOrder":["paper/main.qmd","${oldPath}"],"userInteger":9007199254740993,"note":"${oldPath}","nested":{"documentOrder":["${oldPath}"]}}\n`);
  return root;
}
function link(target: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir');
}
type Tree = Record<string, string>;
function tree(root: string, metadata = false): Tree {
  const result: Tree = {};
  function visit(file: string, rel: string) {
    const s = fs.lstatSync(file);
    const value = s.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : s.isDirectory() ? 'dir' : `file:${fs.readFileSync(file).toString('base64')}`;
    result[rel] = value + (metadata ? `|${s.ino}|${s.mtimeMs}|${s.mode}` : '');
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), rel ? `${rel}/${name}` : name);
  }
  visit(root, '');
  return result;
}
function expectText(expected: Tree, rel: string, text: string) {
  for (let dir = path.posix.dirname(rel); dir !== '.'; dir = path.posix.dirname(dir)) expected[dir] = 'dir';
  expected[rel] = 'file:' + Buffer.from(text).toString('base64');
}
function expectMove(expected: Tree, from: string, to: string) {
  for (const rel of Object.keys(expected)) if (rel === from || rel.startsWith(from + '/')) {
    expected[to + rel.slice(from.length)] = expected[rel]; delete expected[rel];
  }
  for (let dir = path.posix.dirname(to); dir !== '.'; dir = path.posix.dirname(dir)) expected[dir] = 'dir';
}
function sameTree(actual: Tree, expected: Tree, message: string) {
  const differing = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].filter((key) => actual[key] !== expected[key]);
  h.eq(differing, [], message);
}
async function run(args: string[], expectedCode = 0, nodeArgs: string[] = [], extraEnv = {}) {
  const child = scope.spawn(script, args, { nodeArgs, cwd: reports, env: { ...env, ...extraEnv }, deadlineMs: 30000 });
  await child.closed;
  h.eq(child.code, expectedCode, `child exit ${expectedCode}: ${args.join(' ')}`);
  h.eq(child.stderr, '', 'plain Node child has clean stderr');
  const reportPath = /Report file: (".*")/.exec(child.stdout)?.[1];
  h.ok(reportPath, 'report path is printed');
  if (reportPath) h.eq(read(JSON.parse(reportPath)), child.stdout.trimEnd() + '\n', 'report file contains the entire stdout plan');
  return child.stdout;
}

try {
  h.section('historical text census and standalone contract');
  // Frozen SHA-256 values from git show: context ed7063a/130b84c/4f9f761;
  // guides dfdcb37/95748af, ff19db6/9328cbd/ce038ca/2002786, 32fb174.
  const hashes = [
    '85bfc78399fca3e05fe591ad74c257facca0b9feda37b16eac839b3f6e5031c9',
    '379e9a2139ecbc8af035ca05e9bb8ae759e6927b7dd5a4061e268f83982d4b23',
    '9b3b4a58a6f0fc32f9605e9eeade426ed287a0dce0d7f93b4097b5eb17379689',
    '784a7f1d5bf4fa044b905d2195ab716c5b8b9198e959f762e19a6e91eb5fe2ee',
    '1c7157e943260d554a82fb0ad3be0daaa50877640456fb21850e93eb557f0b91',
    '842e92e908bd3fda99552876b73fefff429f7a9b9c511f4b0904dcfd31e651c5',
    '791156599d5abb0d3e5bb705a490d0aeef93ff1be6f07af4c7521352965abedc',
    '527bb53170135419f7918922fcc592f4441d02ae39b27bb162c72f3961c5d824',
    'f0c9289bf04b173db3f284e86c24a01f4cce768f9f76c84f403070f19d116034',
    'be97c85cfbb35d9579b1a881a079615fba9e504f33bc8d856f01bc599f6e5d9e',
  ];
  h.eq([historicalMission('History fixture'), HISTORICAL_NOTEBOOK, HISTORICAL_AGENTS_STUB, ...HISTORICAL_GUIDES.map((fn: (title: string) => string) => fn('History fixture'))].map((s) => createHash('sha256').update(s).digest('hex')), hashes, 'all ten historical generated texts match the audited git bytes');
  const code = read(script);
  h.ok([...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].every((m) => m[1].startsWith('node:')), 'only node: imports; no app/runtime dependency');
  h.ok(!/\b(?:copyFile(?:Sync)?|cpSync)\s*\(/.test(code), 'no archive copy fallback');

  h.section('real-project fixtures');
  const flat = project('flat');
  fs.mkdirSync(path.join(flat, 'Context/Transcripts'), { recursive: true });
  put(path.join(flat, 'Context/Dispatches/brief.md'), 'a flat brief\n');
  put(path.join(flat, 'Context/Dispatches/result.json'), '{"result":"kept"}\n');
  put(path.join(flat, '.meta/agent/session.json'), '{"session":"kept"}\n');
  put(path.join(flat, oldPath), historicalMission('flat'));
  put(path.join(flat, 'Context/Project/MISSION.comments.json'), '{"threads":[{"id":"thread-unchanged","messages":[{"id":"message-unchanged","body":"keep"}]}]}\n');
  put(path.join(flat, 'Context/NOTEBOOK.md'), HISTORICAL_NOTEBOOK);
  put(path.join(flat, 'AGENTS.md'), HISTORICAL_AGENTS_STUB);
  put(path.join(flat, '.gitignore'), 'exports/\n.meta/agent/\n# user comment\n.meta/agent/ # user pattern\n');
  put(path.join(flat, 'paper/linked.qmd'), '[mission](../Context/Project/MISSION.qmd)\n{{< include ../Context/Project/MISSION.qmd >}}\n');
  put(path.join(flat, '.stignore'), '// keep sync history\n');
  fs.mkdirSync(path.join(flat, '.stfolder'));
  for (const args of [['init', '-q', flat], ['-C', flat, 'add', '--', 'project.json', 'Context']]) {
    const child = spawnSync('git', args, { env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
    if (child.status !== 0) throw new Error(`scratch git fixture: ${child.stderr || child.error}`);
  }
  const gitIndex = fs.readFileSync(path.join(flat, '.git/index'));
  const bulky = project('acuteNeuropixel');
  for (let i = 0; i < 61; i++) put(path.join(bulky, 'Context/Dispatches', String(i), 'log.txt'), `record ${i}\n`);
  const customMission = '---\r\ntitle: "Mission — My science"\r\nformat: html\r\n---\r\n\r\n## Question\r\n\r\nKeep MY question.  \r\n';
  put(path.join(bulky, oldPath), customMission);
  put(path.join(bulky, 'Context/Project/data-notes.md'), 'user material\n');
  const h2s = HISTORICAL_NOTEBOOK + '\n## 2026-08-11 — old dated entry\n\n## Results\n\nBody  \n\n## Session log\nA second heading stays.\n';
  put(path.join(bulky, 'Context/NOTEBOOK.md'), h2s);
  put(path.join(bulky, 'AGENTS.md'), HISTORICAL_AGENTS_STUB + '\nUser convention: always keep this.\n');
  put(path.join(bulky, 'CLAUDE.md'), 'My instructions\n');
  const anomaly = project('FluxProj__Synaptic_Sleep');
  const starter = '---\ntitle: "Notes"\n---\n\n# Notes\nStart writing here.\n';
  put(path.join(anomaly, oldPath), starter);
  const handNotebook = '# Hand-written notebook\n\nMy lab notes  \n## State\nKeep this.\n';
  put(path.join(anomaly, 'Context/NOTEBOOK.md'), handNotebook);
  put(path.join(anomaly, 'Context/RULES.md'), 'My rules\n');
  const normalized = project('normalized');
  const quotedTitle = 'A "quoted" project';
  put(path.join(normalized, oldPath), historicalMission(quotedTitle).split('\n').map((line: string) => line + ' \t').join('\r\n'));
  put(path.join(normalized, 'AGENTS.md'), HISTORICAL_AGENTS_STUB.replace(/\n/g, '  \r\n'));
  put(path.join(normalized, 'Context/NOTEBOOK.md'), HISTORICAL_NOTEBOOK.replace(/\n/g, '  \r\n'));
  const handwritten = project('edited-guide');
  const editedGuide = HISTORICAL_GUIDES[0]('edited-guide').replace('## Safety', '## My safety rules');
  put(path.join(handwritten, 'AGENTS.md'), editedGuide);
  const fenced = '# Notebook\n\n```md\n## Session log\n' + oldInstruction + '\n```\n\n<!-- my comment\n## Session log\n-->\n\n## Session log\n\n' + oldInstruction + '\n';
  put(path.join(handwritten, 'Context/NOTEBOOK.md'), fenced);
  const guides = HISTORICAL_GUIDES.map((guide: (title: string) => string, index: number) => {
    const dir = project(`guide-${index}`);
    put(path.join(dir, 'AGENTS.md'), guide(`Previous title ${index}`));
    return dir;
  });
  const skipped = ['archived/old', 'node_modules/pkg', '.git/hidden', '.claude/worktrees/task', 'a/b/c/d/e/f/too-deep'].map((name) => project(name));
  const boundary = project('a/b/c/d/boundary'); // project.json depth 6
  const outside = project('external', path.join(scratch, 'outside'));
  link(outside, path.join(roots, 'linked-project'));

  const config = path.join(home, 'FluxConfig');
  for (const name of ['agents.json', '.agents-last.json', 'agents.json.bak', 'agents.json.bak.2']) put(path.join(config, name), `original ${name}\n`);
  put(path.join(config, 'Context/UserContext/RULES.md'), 'never edit my global rules\n');
  put(path.join(config, 'Context/FluxContext/PRINCIPAL.md'), 'stock pruning is the app job\n');
  put(path.join(config, '.stignore'), 'keep me\n');
  fs.mkdirSync(path.join(config, '.stfolder'));
  const checkout = path.join(scratch, 'fake-checkout');
  put(path.join(checkout, 'package.json'), '{"name":"flux"}\n');
  fs.mkdirSync(path.join(checkout, '.git'));
  fs.mkdirSync(path.join(checkout, 'skills/flux'), { recursive: true });
  put(path.join(checkout, 'skills/flux/SKILL.md'), 'old skill bytes\n');
  const ownedLinks = ['.claude', '.agents'].map((vendor) => path.join(home, vendor, 'skills/flux'));
  for (const dest of ownedLinks) link(path.join(checkout, 'skills/flux'), dest);
  put(path.join(home, '.agents/skills/flux.pre-neutral/SKILL.md'), 'preserve the older skill\n');
  put(path.join(home, '.config/systemd/user/syncthing.service'), '[Unit]\nDescription=Retired sync\n');

  const beforeRoots = tree(roots, true);
  const beforeHome = tree(home, true);
  const outsideBefore = tree(outside, true);
  const checkoutBefore = tree(checkout, true);
  const dispatchStat = fs.statSync(path.join(flat, 'Context/Dispatches/brief.md'));
  const largeStat = fs.statSync(path.join(bulky, 'Context/Dispatches'));
  const rosterStat = fs.statSync(path.join(config, 'agents.json'));
  const commentsStat = fs.statSync(path.join(flat, 'Context/Project/MISSION.comments.json'));
  const dry = await run(['--roots', roots, flat]); // overlapping roots deduplicate projects
  sameTree(tree(roots, true), beforeRoots, 'dry run changes no project bytes, modes, inodes, or mtimes');
  sameTree(tree(home, true), beforeHome, 'dry run changes no machine bytes, modes, inodes, or mtimes');
  h.ok(fs.readdirSync(reports).length === 1 && /migration-report-\d{4}-\d{2}-\d{2}-\d{4}\.md/.test(fs.readdirSync(reports)[0]), 'dry run writes only its prescribed report artifact');
  for (const phrase of ['DRY RUN', 'not a mission — review it', 'kept nonempty Context/Project/', 'Git project:', 'index is unchanged', 'references the old MISSION.qmd', 'flux.pre-neutral', 'Syncthing leftover', 'user-authored or edited AGENTS.md', newInstruction]) h.ok(dry.includes(phrase), `report includes ${phrase}`);
  h.ok(!dry.includes(`Project: ${JSON.stringify(outside)}`), 'discovery never follows project symlinks');

  const expectedRoots = tree(roots);
  const expectedHome = tree(home);
  const migrating = [flat, bulky, anomaly, normalized, handwritten, ...guides, boundary];
  for (const root of migrating) {
    const prefix = path.relative(roots, root).split(path.sep).join('/');
    if (root !== bulky) expectText(expectedRoots, `${prefix}/CLAUDE.md`, '@AGENTS.md\n');
    expectText(expectedRoots, `${prefix}/.gitignore`, root === flat ? 'exports/\n# user comment\n.meta/agent/ # user pattern\n' + ignore : ignore);
    if ([flat, bulky, anomaly, normalized].includes(root)) {
      expectMove(expectedRoots, `${prefix}/${oldPath}`, `${prefix}/${newPath}`);
      expectText(expectedRoots, `${prefix}/project.json`, read(path.join(root, 'project.json')).replace(`"documentOrder":["paper/main.qmd","${oldPath}"]`, `"documentOrder":["paper/main.qmd","${newPath}"]`));
      if (root !== bulky) delete expectedRoots[`${prefix}/Context/Project`];
    }
  }
  for (const [root, name, rel] of [[flat, 'Dispatches', 'Context/Dispatches'], [flat, 'agent', '.meta/agent'], [bulky, 'Dispatches', 'Context/Dispatches']]) {
    const prefix = path.basename(root);
    expectMove(expectedRoots, `${prefix}/${rel}`, `${prefix}/${archive}/${name}`);
    expectText(expectedRoots, `${prefix}/${archive}/README.md`, archiveReadme);
  }
  delete expectedRoots['flat/Context/Transcripts'];
  expectMove(expectedRoots, 'flat/Context/Project/MISSION.comments.json', 'flat/Context/ProjectContext.comments.json');
  expectText(expectedRoots, 'flat/' + newPath, newContext('flat'));
  expectText(expectedRoots, 'normalized/' + newPath, newContext(quotedTitle));
  expectText(expectedRoots, 'acuteNeuropixel/' + newPath, customMission.replace('title: "Mission — ', 'title: "Project context — '));
  for (const root of [flat, normalized, ...guides]) expectText(expectedRoots, path.basename(root) + '/AGENTS.md', newStub);
  expectText(expectedRoots, 'flat/Context/NOTEBOOK.md', HISTORICAL_NOTEBOOK.replace(oldComment, newComment).replace('## Session log', '## Log').replace(oldInstruction, newInstruction));
  expectText(expectedRoots, 'acuteNeuropixel/Context/NOTEBOOK.md', h2s.replace(oldComment, newComment).replace('## Session log', '## Log').replace(oldInstruction, newInstruction));
  const normalizedNotebook = HISTORICAL_NOTEBOOK.replace(oldComment, newComment.replace(/\n/g, '\n')).replace('## Session log', '## Log').replace(oldInstruction, newInstruction).replace(/\n/g, '  \r\n');
  // Replacement comment has the exact new text; untouched lines retain trailing spaces.
  expectText(expectedRoots, 'normalized/Context/NOTEBOOK.md', normalizedNotebook.replace(newComment.replace(/\n/g, '  \r\n') + '  \r\n', newComment.replace(/\n/g, '\r\n') + '\r\n'));
  expectText(expectedRoots, 'edited-guide/Context/NOTEBOOK.md', fenced.replace('\n## Session log\n\n' + oldInstruction, '\n## Log\n\n' + newInstruction));
  for (const name of ['agents.json', '.agents-last.json', 'agents.json.bak', 'agents.json.bak.2']) expectMove(expectedHome, 'FluxConfig/' + name, 'FluxConfig/.retired-2026-09/' + name);
  for (const vendor of ['.claude', '.agents']) delete expectedHome[`${vendor}/skills/flux`];

  const applied = await run(['--roots', roots, '--apply']);
  h.ok(applied.includes('Failed actions: 0'), 'first apply has no failed actions');
  sameTree(tree(roots), expectedRoots, 'apply produces the exact expected project trees, including all preserved bytes');
  sameTree(tree(home), expectedHome, 'apply produces the exact expected machine tree');
  sameTree(tree(outside, true), outsideBefore, 'outside linked project stays byte-identical');
  sameTree(tree(checkout, true), checkoutBefore, 'removing the skill links leaves checkout targets untouched');
  h.ok(fs.readFileSync(path.join(flat, '.git/index')).equals(gitIndex), 'real git index stays byte-identical');
  h.eq(fs.statSync(path.join(flat, archive, 'Dispatches/brief.md')).ino, dispatchStat.ino, 'flat dispatch file retains its inode (rename, not copy)');
  h.eq(fs.statSync(path.join(bulky, archive, 'Dispatches')).ino, largeStat.ino, '61-entry dispatch tree retains its root inode');
  h.eq(fs.readdirSync(path.join(bulky, archive, 'Dispatches')).length, 61, 'all 61 dispatches preserved');
  h.eq(fs.statSync(path.join(config, '.retired-2026-09/agents.json')).ino, rosterStat.ino, 'roster inode preserved');
  h.eq(fs.statSync(path.join(flat, 'Context/ProjectContext.comments.json')).ino, commentsStat.ino, 'comment sidecar renamed without parsing or changing thread IDs');
  const stableRoots = tree(roots, true);
  const stableHome = tree(home, true);
  const second = await run(['--roots', roots, '--apply']);
  h.ok(second.includes('Planned actions: 0\n'), 'second apply plans nothing (including repeated Session log headings)');
  sameTree(tree(roots, true), stableRoots, 'second apply does not rewrite any project');
  sameTree(tree(home, true), stableHome, 'second apply does not rewrite any machine state');
  h.eq(fs.readdirSync(reports).length, 3, 'same-minute reports never overwrite an earlier report');
  for (const root of skipped) h.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')), `discovery excludes ${path.relative(roots, root)}`);
  const archived = await run(['--roots', path.join(roots, 'archived'), '--include-archived', '--apply']);
  h.ok(archived.includes('Projects discovered: 1') && fs.existsSync(path.join(roots, 'archived/old/CLAUDE.md')), 'include-archived explicitly migrates archived projects');

  h.section('collisions, read-only failures and containment');
  const adversarial = path.join(scratch, 'adversarial');
  const collision = project('collision', adversarial);
  put(path.join(collision, oldPath), historicalMission('collision'));
  put(path.join(collision, 'Context/Project/MISSION.comments.json'), 'old sidecar\n');
  put(path.join(collision, 'Context/ProjectContext.comments.json'), 'different sidecar\n');
  put(path.join(collision, 'Context/Dispatches/data.txt'), 'source archive\n');
  put(path.join(collision, archive, 'Dispatches/data.txt'), 'destination archive\n');
  put(path.join(collision, archive, 'README.md'), 'user archive readme\n');
  const collisionManifest = read(path.join(collision, 'project.json'));
  const unsafe = project('symlinked', adversarial);
  // Junctions need an existing target on Windows.
  fs.mkdirSync(path.join(outside, 'Context'), { recursive: true });
  link(path.join(outside, 'Context'), path.join(unsafe, 'Context'));
  put(path.join(outside, 'Context/NOTEBOOK.md'), HISTORICAL_NOTEBOOK);
  const externalContext = tree(path.join(outside, 'Context'), true);
  const readonly = project('readonly', adversarial);
  put(path.join(readonly, 'Context/Dispatches/log.txt'), 'must survive a failed rename\n');
  const readonlyParent = path.join(readonly, 'Context');
  fs.chmodSync(readonlyParent, 0o555);
  const deniedBefore = tree(readonlyParent, true);
  // Windows has no POSIX read-only directories; root also bypasses modes. In
  // those environments inject the SAME OS error at rename, never skip coverage.
  const fault = path.join(scratch, 'deny-rename.cjs');
  put(fault, `const fs = require('node:fs');\nconst rename = fs.renameSync;\nfs.renameSync = (a,b) => { if (a === ${JSON.stringify(path.join(readonlyParent, 'Dispatches'))}) throw Object.assign(new Error('fixture read-only directory'), {code:'EACCES'}); return rename(a,b); };\nrequire('node:module').syncBuiltinESMExports();\n`);
  const useFault = process.platform === 'win32' || process.getuid?.() === 0;
  if (useFault) console.log('Read-only modes unavailable for this host/user; EACCES injected at the actual rename call.');
  const rejected = await run(['--roots', adversarial, '--apply'], 1, useFault ? ['--require', fault] : []);
  h.ok(rejected.includes('EACCES') || rejected.includes('EPERM'), 'read-only rename failure is reported with OS error');
  sameTree(tree(readonlyParent, true), deniedBefore, 'failed rename leaves read-only source bytes and metadata in place');
  h.ok(!fs.existsSync(path.join(readonly, archive, 'Dispatches')), 'failed rename never falls back to copying');
  h.eq(read(path.join(collision, oldPath)), historicalMission('collision'), 'sidecar collision refuses mission move before touching it');
  h.eq(read(path.join(collision, 'project.json')), collisionManifest, 'sidecar collision does not rewrite documentOrder');
  h.eq(read(path.join(collision, 'Context/Dispatches/data.txt')), 'source archive\n', 'archive source collision preserved');
  h.eq(read(path.join(collision, archive, 'Dispatches/data.txt')), 'destination archive\n', 'archive destination collision preserved');
  h.eq(read(path.join(collision, archive, 'README.md')), 'user archive readme\n', 'user archive README is never overwritten');
  sameTree(tree(path.join(outside, 'Context'), true), externalContext, 'symlinked Context never edits external state');
  h.ok(rejected.includes('symlink path left untouched') && rejected.includes('both comments sidecars exist'), 'report explains containment and collision failures');
  fs.chmodSync(readonlyParent, 0o755);
  await run(['--roots', readonly, '--apply']);
  h.eq(read(path.join(readonly, archive, 'Dispatches/log.txt')), 'must survive a failed rename\n', 'rerun succeeds once permissions are fixed');

  h.section('cross-device rename failure and authored lookalikes');
  const crossDevice = project('cross-device', path.join(scratch, 'cross-device-root'));
  put(path.join(crossDevice, 'Context/Dispatches/log.txt'), 'cross-device source bytes\n');
  const crossSource = path.join(crossDevice, 'Context/Dispatches');
  const crossBefore = tree(crossSource, true);
  const crossFault = path.join(scratch, 'cross-device.cjs');
  put(crossFault, `const fs = require('node:fs'); const rename = fs.renameSync; fs.renameSync = (a,b) => { if (a === ${JSON.stringify(crossSource)}) throw Object.assign(new Error('cross-device link'), {code:'EXDEV'}); return rename(a,b); }; require('node:module').syncBuiltinESMExports();\n`);
  const crossReport = await run(['--roots', crossDevice, '--apply'], 1, ['--require', crossFault]);
  h.ok(crossReport.includes('EXDEV'), 'cross-device failure is reported');
  sameTree(tree(crossSource, true), crossBefore, 'EXDEV preserves source bytes and inode');
  h.ok(!fs.existsSync(path.join(crossDevice, archive, 'Dispatches')), 'EXDEV has no copy fallback');
  const lookalike = project('lookalike', path.join(scratch, 'lookalikes'));
  const editedNotebook = HISTORICAL_NOTEBOOK.replace("Agent-owned: it writes; you read", "User-owned: I write; you read").replace('+ a concise entry.', '+ my preferred entry.');
  put(path.join(lookalike, 'Context/NOTEBOOK.md'), editedNotebook);
  const editedTemplate = historicalMission('Old title').replace('What are we trying to learn?', 'My real question.');
  put(path.join(lookalike, oldPath), editedTemplate);
  const bothMissions = project('both-missions', path.dirname(lookalike));
  put(path.join(bothMissions, oldPath), 'old bytes\n');
  put(path.join(bothMissions, newPath), 'new bytes\n');
  const failedMission = await run(['--roots', path.dirname(lookalike), '--apply'], 1);
  h.eq(read(path.join(lookalike, 'Context/NOTEBOOK.md')), editedNotebook.replace('## Session log', '## Log'), 'edited comment/placeholder preserved; only the real heading changes');
  h.eq(read(path.join(lookalike, newPath)), editedTemplate.replace('title: "Mission — ', 'title: "Project context — '), 'near-template mission keeps every authored byte apart from its exact title');
  h.ok(failedMission.includes('MISSION and ProjectContext both exist'), 'both-mission collision is reported');
  h.eq(read(path.join(bothMissions, oldPath)), 'old bytes\n', 'colliding old mission is kept');
  h.eq(read(path.join(bothMissions, newPath)), 'new bytes\n', 'colliding new context is kept');

  if (process.platform === 'linux') {
    h.section('running Syncthing is reported, never stopped');
    const fakeSync = path.join(scratch, 'fake-syncthing.mjs');
    put(fakeSync, "process.title = 'syncthing'; console.log('READY'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
    const daemon = scope.spawn(fakeSync, [], { nodeArgs: [], env, cwd: scratch, readyLine: 'READY', deadlineMs: 30000 });
    await daemon.ready;
    const running = await run(['--roots', boundary, '--apply']);
    h.ok(running.includes(`pid ${daemon.child.pid}`) && running.includes('running syncthing; reported only, never stopped'), 'process census reports the scratch Syncthing process');
    h.ok(!daemon.exited, 'migration leaves the reported process running');
    daemon.child.stdin.end();
    await daemon.closed;
  }

  h.section('interrupted rename keeps its report and resumes');
  const interrupted = project('interrupted', path.join(scratch, 'interrupted-root'));
  put(path.join(interrupted, oldPath), historicalMission('Original title'));
  put(path.join(interrupted, 'Context/Project/MISSION.comments.json'), '{"id":"surviving-thread"}\n');
  const interruptModule = path.join(scratch, 'interrupt.cjs');
  put(interruptModule, `const fs = require('node:fs'); const rename = fs.renameSync; fs.renameSync = (a,b) => { const result = rename(a,b); if (a === ${JSON.stringify(path.join(interrupted, oldPath))}) process.exit(77); return result; }; require('node:module').syncBuiltinESMExports();\n`);
  const previousReports = new Set(fs.readdirSync(reports));
  const crash = scope.spawn(script, ['--roots', interrupted, '--apply'], { nodeArgs: ['--require', interruptModule], env, cwd: reports, deadlineMs: 30000 });
  await crash.closed;
  h.eq(crash.code, 77, 'fixture terminates immediately after the mission rename');
  const savedReport = fs.readdirSync(reports).find((file) => !previousReports.has(file));
  h.ok(savedReport && read(path.join(reports, savedReport)).includes(newContext('Original title')), 'complete migration plan was flushed before the interrupted mutation');
  h.eq(read(path.join(interrupted, newPath)), historicalMission('Original title'), 'interruption preserves original bytes at the new path');
  await run(['--roots', interrupted, '--apply']);
  h.eq(read(path.join(interrupted, newPath)), newContext('Original title'), 'rerun finishes the exact-template update after an interrupted rename');
  h.eq(read(path.join(interrupted, 'Context/ProjectContext.comments.json')), '{"id":"surviving-thread"}\n', 'rerun preserves and relocates the pending sidecar');
  const completed = await run(['--roots', interrupted, '--apply']);
  h.ok(completed.includes('Planned actions: 0\n'), 'recovered migration is idempotent');

  h.section('dangling owned skill symlinks');
  const retiredCheckout = path.join(scratch, 'retired-checkout');
  put(path.join(retiredCheckout, 'package.json'), '{"name":"flux"}\n');
  put(path.join(retiredCheckout, '.git'), 'gitdir: a retired worktree\n');
  fs.mkdirSync(path.join(retiredCheckout, 'skills/flux'), { recursive: true });
  link(path.join(retiredCheckout, 'skills/flux'), ownedLinks[0]);
  fs.rmdirSync(path.join(retiredCheckout, 'skills/flux'));
  await run(['--roots', boundary, '--apply']);
  h.ok(!fs.lstatSync(ownedLinks[0], { throwIfNoEntry: false }), 'owned dangling flux skill link is removed after checkout upgrade');

  h.section('default roots, machine collisions, unmanaged skills');
  const discovered = project('registry-project', path.join(scratch, 'registered'));
  const userData = process.platform === 'darwin' ? path.join(home, 'Library/Application Support/flux') : process.platform === 'win32' ? path.join(env.APPDATA, 'flux') : path.join(env.XDG_CONFIG_HOME, 'flux');
  put(path.join(userData, 'projects.json'), JSON.stringify({ v: 1, projects: [{ root: discovered, title: 'Registry project' }] }));
  // Default discovery includes /data when present. Hide ONLY that OS path in the
  // fixture child so this gate can never inspect real projects under /data.
  const noData = path.join(scratch, 'no-data.cjs');
  put(noData, `const fs = require('node:fs'); const stat = fs.lstatSync; fs.lstatSync = (p, ...args) => { if (p === '/data') throw Object.assign(new Error('fixture has no /data'), {code:'ENOENT'}); return stat(p, ...args); }; require('node:module').syncBuiltinESMExports();\n`);
  const defaultReport = await run(['--apply'], 0, ['--require', noData]);
  h.ok(defaultReport.includes(`Root: ${JSON.stringify(discovered)}`) && fs.existsSync(path.join(discovered, 'CLAUDE.md')), 'default roots load projects.json from the lowercase platform config dir');
  put(path.join(config, 'agents.json'), 'new roster must not clobber retired roster\n');
  put(path.join(home, '.claude/skills/flux/SKILL.md'), 'user skill directory\n');
  const fakeOther = path.join(scratch, 'non-flux/skills/flux');
  fs.mkdirSync(fakeOther, { recursive: true });
  link(fakeOther, ownedLinks[1]);
  const homeCollision = tree(home, true);
  const kept = await run(['--roots', discovered, '--apply'], 1);
  sameTree(tree(home, true), homeCollision, 'machine archive collisions and unowned skills change no machine state');
  h.ok(kept.includes('destination exists') && kept.includes('not a Flux-owned symlink') && kept.includes('checkout ownership unproven'), 'machine conflict report explains each retained artifact');
} catch (error) {
  h.fail(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await scope.dispose();
  // Restore read-only fixture even after an earlier assertion fails.
  const dir = path.join(scratch, 'adversarial/readonly/Context');
  if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755);
}
await h.done(() => fs.rmSync(scratch, { recursive: true, force: true }));
