import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveOwnCliCommandsSync } from '../../electron/fluxPaths.cjs';

export async function agentFixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-agent-setup-'));
  const original = { ...process.env };
  const home = path.join(temp, 'home with spaces'), bin = path.join(temp, 'bin');
  await fs.mkdir(home); await fs.mkdir(bin);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    APPDATA: path.join(home, '.config'), LOCALAPPDATA: path.join(home, 'local'), CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PATH: bin, Path: bin, SHELL: '', FAKE_AGENT_LOG: path.join(temp, 'argv.jsonl') });
  delete process.env.FLUX_NO_MIGRATE;
  for (const name of ['FAKE_NO_ADD_JSON', 'FAKE_CODEX_HOOKS', 'FAKE_MCP_CASE', 'FAKE_FAIL_ADD']) delete process.env[name];
  const program = path.join(bin, 'vendor.cjs');
  await fs.writeFile(program, `const fs=require('node:fs'),p=require('node:path');
const [vendor,...a]=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_AGENT_LOG,JSON.stringify({vendor,args:a})+'\\n');
const file=p.join(process.env.HOME,'.claude.json');let data={};try{data=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
function save(){fs.mkdirSync(p.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data,null,2)+'\\n')}
if(vendor==='codex'){if(a.join(' ')==='features list'){console.log(process.env.FAKE_CODEX_HOOKS==='0'?'old_features stable true':'hooks stable true');process.exit(0)}process.exit(1)}
if(a.join(' ')==='mcp --help'){console.log(process.env.FAKE_NO_ADD_JSON?'add get remove':'add add-json get remove');process.exit(0)}
if(a[0]!=='mcp')process.exit(2);
if(a[1]==='get'){if(!data.mcpServers?.flux)process.exit(1);console.log(JSON.stringify(data.mcpServers.flux));process.exit(0)}
if(a[2]!=='flux')throw Error('name must precede variadic flags');
if(a[1]==='remove'){delete data.mcpServers.flux;if(!Object.keys(data.mcpServers).length)delete data.mcpServers;save();process.exit(0)}
if(a[1]==='add-json'){if(process.env.FAKE_FAIL_ADD)process.exit(9);if(a[4]!=='--scope'||a[5]!=='user')throw Error('wrong add-json argv');data.mcpServers={...data.mcpServers,flux:JSON.parse(a[3])};save();process.exit(0)}
if(a[1]==='add'){if(a[3]!=='--scope'||a[4]!=='user'||a[5]!=='--env')throw Error('wrong fallback argv');const i=a.indexOf('--');if(i<6)throw Error('missing separator');const env=Object.fromEntries(a.slice(6,i).map(x=>{const j=x.indexOf('=');return [x.slice(0,j),x.slice(j+1)]}));data.mcpServers={...data.mcpServers,flux:{type:'stdio',command:a[i+1],args:a.slice(i+2),env}};save();process.exit(0)}
process.exit(2);
`);
  for (const vendor of ['claude', 'codex']) {
    const file = path.join(bin, vendor + (process.platform === 'win32' ? '.cmd' : ''));
    await fs.writeFile(file, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${program}" ${vendor} %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${program}" ${vendor} "$@"\n`, { mode: 0o755 });
  }
  const install = path.join(temp, 'fixture install');
  await fs.mkdir(path.join(install, 'dist'), { recursive: true });
  const cli = path.join(install, 'dist', 'flux-cli.mjs');
  await fs.writeFile(cli, `// flux-agent-build commit=fixture-build
import readline from 'node:readline';
if(process.argv[2]==='version'){console.log(JSON.stringify({commit:'fixture-build',node:process.version}));}
else if(process.argv[2]==='mcp'){
 if(process.env.FAKE_MCP_CASE==='noise')console.log('bad stdout');
 console.error('flux MCP server on stdio');
 const rl=readline.createInterface({input:process.stdin});
 rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'flux',version:'1'}}}));
 if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:process.env.FAKE_MCP_CASE==='missing'?'wrong':'connect'},...Array.from({length:100},(_,i)=>({name:'tool_'+i}))]}}));});
}
`);
  const runtime = resolveOwnCliCommandsSync({ appRoot: install, nodePath: process.execPath, build: 'fixture-build', packaged: false, appImage: '' });
  async function put(relative: string, text: string) { const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; }
  async function read(relative: string) { return fs.readFile(path.join(home, relative), 'utf8'); }
  async function argv() { return (await fs.readFile(process.env.FAKE_AGENT_LOG!, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  async function cleanup() {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original); await fs.rm(temp, { recursive: true, force: true });
  }
  return { temp, home, bin, runtime, put, read, argv, cleanup };
}
export async function tree(root: string, includeBackups = true) {
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix = '') {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!includeBackups && e.name.includes('.bak-flux-')) continue;
      const name = prefix + e.name, file = path.join(dir, e.name);
      if (e.isSymbolicLink()) files[name] = 'link:' + await fs.readlink(file);
      else if (e.isDirectory()) await walk(file, name + '/');
      else files[name] = (await fs.readFile(file)).toString('base64');
    }
  }
  await walk(root); return files;
}
