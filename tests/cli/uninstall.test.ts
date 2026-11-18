import { createHash } from 'crypto';
import { prepareInstallSelectionSwitch, versions } from '../../src/cli/installer/install-profile';
import { beforeAll, test, expect } from 'bun:test';
import { installStateFixturePath, recordLegacyInstallOwnership, recordPluginSelection, seedGlobalPackageFixture, seedPathRecords, withTempHome } from '../helpers/install-ownership';
import { runInstall, runUninstall } from '../../src/cli/commands/install';
import { ensureHerdrCore } from '../../src/cli/commands/global-runtime';
import { HC_MIN_VERSION } from '../../src/core/terminal/herdr-pin';
import { startFakeHcRelease, writeFakeUserPathPowershell } from '../helpers/fake-hc';
import { jsonFragment } from '../../src/core/host-config/json-fragment';
import { CLAUDE_ROOT_CONFIG_BACKUP, CODEGRAPH_MCP_SELECTOR } from '../../src/core/host-config/claude-config';
import type { PathCommitted } from '../../src/core/host-config/types';
import { pathRecordHost, pathRecordKey } from '../../src/effects/host-config/path-records';
import { hashManagedTree } from '../../src/effects/managed-tree';
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync, lstatSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { spawnSync } from 'child_process';
import { runUserUninstall } from '../../src/cli/installer/uninstall';
import { configurationReceiptPath } from '../../src/cli/installer/configuration-ownership';
import { migrateCodexConfigRecords, planCodexConfigMigration } from '../../src/cli/installer/codex-config-migration';
import { requestUserInputFragment } from '../../src/cli/installer/targets/codex';
import { tomlFragment } from '../../src/core/host-config/toml-fragment';
import { openHostConfigGate } from '../../src/effects/host-config/gate';
import { buildManagedHooks } from '../../src/cli/installer/managed-entries';
import { applyGlobalContextRefresh, preflightGlobalContextRefresh, renderGlobalRulesBlock } from '../../src/cli/installer/global-context';
const CLI = join(import.meta.dir, '../../src/cli/index.ts');
beforeAll(() => { seedGlobalPackageFixture(); });
function fixture(run: (home: string, env: NodeJS.ProcessEnv) => void) {
 const home = mkdtempSync(join(tmpdir(), 'user-uninstall-'));
 // Git config and the user excludes file resolve from the temporary HOME only.
 const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }; delete env.XDG_STATE_HOME; delete env.XDG_CONFIG_HOME; delete env.GIT_CONFIG_GLOBAL;
 try { run(home, env); } finally { rmSync(home, { recursive: true, force: true }); }
}
function put(home: string, path: string, content: string) { const absolute = join(home, path); mkdirSync(join(absolute, '..'), {recursive:true}); writeFileSync(absolute,content); }
/** rh's own write of the Codex input-mode key, through the host-config gate. */
function rhWritesInputMode(env: NodeJS.ProcessEnv, path: string) {
 openHostConfigGate({env}).apply([{path,fragments:[requestUserInputFragment(existsSync(path)?readFileSync(path,'utf8'):'')!]}]);
}
function ledger(home: string) { return JSON.parse(readFileSync(join(home,'.repo-harness/config/ledger.json'),'utf8')); }
function tree(home: string): string { return readdirSync(home, {recursive:true}).sort().map(String).map(p => {try{return `${p}:${readFileSync(join(home,p),'utf8')}`;}catch{return p;}}).join('\n'); }
test('restores original config, preserves siblings and archives, dry run is byte-identical', () => fixture((home, env) => {
 // An earlier rh version recorded its Codex change in the receipt; the first uninstall migrates it to the ledger.
 put(home,'.codex/config.toml','default_mode_request_user_input = true\nmodel = "user"\n');
 put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path:join(home,'.codex/config.toml'),selector:'default_mode_request_user_input',before:'default_mode_request_user_input = false\n',installed:'default_mode_request_user_input = true\n',active:true}]}));
 put(home,'.claude/settings.json',JSON.stringify({theme:'dark',hooks:{...buildManagedHooks('claude'),UserPromptSubmit:[{hooks:[{type:'command',command:'user-hook'}]}]}}));
 put(home,'.repo-harness/config.json',JSON.stringify({refactor_recommendations:{enabled:true},architecture:{projection_provider:'archctx',projection_apply:'manual'},custom:42}));
 put(home,'vault/archive.md','keep'); put(home,'.repo-harness/history/log','keep');
 const before=tree(home);
 const preview=runUserUninstall({target:'both',dryRun:true,env});
 expect(preview.status).toBe('complete'); expect(tree(home)).toBe(before);
 const result=runUserUninstall({target:'both',env}); expect(result.status).toBe('complete');
 expect(readFileSync(join(home,'.codex/config.toml'),'utf8')).toBe('default_mode_request_user_input = false\nmodel = "user"\n');
 expect(JSON.parse(readFileSync(join(home,'.claude/settings.json'),'utf8')).hooks.UserPromptSubmit[0].hooks[0].command).toBe('user-hook');
 expect(JSON.parse(readFileSync(join(home,'.repo-harness/config.json'),'utf8'))).toEqual({custom:42});
 expect(readFileSync(join(home,'vault/archive.md'),'utf8')).toBe('keep');
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect({receipt:existsSync(configurationReceiptPath(home)),files:ledger(home).files}).toEqual({receipt:false,files:{}});
}));
test('a pre-separator ledger table goes only with a whole-file revert, which gives back the bytes of the old uninstall', () => {
 // The old receipt recorded the table without the line break before it, so that line break may be the user's.
 const rows=[{before:null,lineBreak:'\n',edited:false},{before:'[mcp_servers.codegraph]\ncommand = "user"',lineBreak:'\n',edited:false},{before:null,lineBreak:'\r\n',edited:false},{before:null,lineBreak:'\n',edited:true}] as const;
 for (const row of rows) fixture((home,env)=>{
  const name=JSON.stringify(row);
  const path=join(home,'.codex/config.toml');const installed='[mcp_servers.codegraph]\ncommand = "codegraph"';
  put(home,'.codex/config.toml',`model = "user"${row.lineBreak}${installed}`);
  put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path,selector:'mcp_servers.codegraph',before:row.before,installed,active:true}]}));
  const adoption=planCodexConfigMigration(env)!.adoption!;
  openHostConfigGate({env}).adopt(path,{...adoption,fragments:adoption.fragments.map(({owner,selector,kind})=>({owner,selector,kind,inserted:''}))});
  if(row.edited){migrateCodexConfigRecords(env);put(home,'.codex/config.toml',`model = "edited"${row.lineBreak}${installed}`);}
  const result=runUserUninstall({target:'codex',env});
  expect(result.status,`${name} ${result.lines.join('\n')}`).toBe(row.edited?'partial':'complete');
  expect(readFileSync(path,'utf8'),name).toBe(row.edited?`model = "edited"${row.lineBreak}${installed}`:`model = "user"${row.lineBreak}${row.before??''}`);
  if(!row.edited) expect(ledger(home).files,name).toEqual({});
 });
});
test('legacy EOF table removal keeps user bytes after an edit, refresh, or profile switch then uninstall', () => {
 for(const lineBreak of ['\n','\r\n']) for(const source of ['receipt','manifest']) for(const action of ['unrelated edit','blank-line edit','refresh','profile switch']) fixture((home,env)=>{
  const path=join(home,'.codex/config.toml');
  const installed=`[mcp_servers.codegraph]${lineBreak}command = "codegraph"`;
  put(home,'.codex/config.toml',`${action==='unrelated edit'?'model = "user"':''}${lineBreak}${installed}`);
  if(source==='receipt') put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path,selector:'mcp_servers.codegraph',before:null,installed,active:true}]}));
  else legacyProfile(home,path,installed.replace(/\r\n/g,'\n'));
  migrateCodexConfigRecords(env);
  const user=action==='unrelated edit'?`# user edit${lineBreak}model = "edited"${lineBreak}`:lineBreak.repeat(action==='blank-line edit'?2:1);
  put(home,'.codex/config.toml',user+installed);
  expect(readFileSync(path,'utf8')).toBe(user+installed);
  if(action==='refresh'){
   const result=openHostConfigGate({env}).apply([{path,fragments:[{owner:'architecture',selector:'mcp_servers.codegraph',kind:'refresh',strategy:tomlFragment,value:`${installed}${lineBreak}args = ["serve"]`}]}]);
   expect(result.skipped).toEqual([]);
   expect(readFileSync(path,'utf8')).toBe(`${user}${installed}${lineBreak}args = ["serve"]`);
  }
  if(action==='profile switch'){
   recordPluginSelection(env);
   prepareInstallSelectionSwitch([],env,join(home,'transaction'));
   expect(readFileSync(path,'utf8')).toBe(user);
  }
  const result=runUserUninstall({target:'codex',env});
  expect(result.status,`${JSON.stringify({lineBreak,source,action})} ${result.lines.join('\n')}`).toBe('complete');
  expect(readFileSync(path,'utf8'),JSON.stringify({lineBreak,source,action})).toBe(user);
  expect(ledger(home).fragments).toEqual([]);
 });
});

test('an interrupted change in the receipt fails closed with its recovery step only for the target that owns its file', () => {
 // A pending entry of the other host stays in the receipt, byte for byte, and does not block this target.
 const rows=[{pending:['codex'],target:'both',status:'partial'},{pending:['codex'],target:'claude',status:'complete'},{pending:['claude'],target:'codex',status:'complete'},{pending:['codex','claude'],target:'claude',status:'partial'}] as const;
 for(const row of rows) fixture((home,env)=>{
  const name=JSON.stringify(row);
  const paths={codex:join(home,'.codex/config.toml'),claude:join(home,'.claude/settings.json')};
  const selectors={codex:'default_mode_request_user_input',claude:'allowedTools.codegraph'};
  put(home,'.codex/config.toml','default_mode_request_user_input = true\n');
  put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[],pending:{id:'x',before:row.pending.map((host)=>({path:paths[host],selector:selectors[host],value:null}))}}));
  const before=tree(home);const receipt=readFileSync(configurationReceiptPath(home),'utf8');const result=runUserUninstall({target:row.target,env});
  expect(result.status,name).toBe(row.status);
  expect(result.lines.join('\n').includes('from its value in the "pending" block'),name).toBe(row.status==='partial');
  if(row.status==='partial') expect(tree(home),name).toBe(before); else expect(readFileSync(configurationReceiptPath(home),'utf8'),name).toBe(receipt);
 });
});
test('user edits are preserved and return partial, with the ledger record retained', () => fixture((home,env)=>{
 rhWritesInputMode(env,join(home,'.codex/config.toml'));
 put(home,'.codex/config.toml','default_mode_request_user_input = false\n');
 const result=runUserUninstall({target:'both',env});expect(result.status).toBe('partial');
 expect(readFileSync(join(home,'.codex/config.toml'),'utf8')).toContain('false');expect(Object.keys(ledger(home).files)).toHaveLength(1);
}));
test('fresh adapter-only uninstall is idempotent',()=>fixture((home,env)=>{
 rhWritesInputMode(env,join(home,'.codex/config.toml'));
 put(home,'.codex/hooks.json',JSON.stringify({hooks:buildManagedHooks('codex')}));
 expect(runUserUninstall({target:'both',env}).exitCode).toBe(0);
 // The migration does not prove that rh created the file or its event arrays, so they stay, empty.
 expect(Object.values(JSON.parse(readFileSync(join(home,'.codex/hooks.json'),'utf8')).hooks).flat()).toEqual([]);
 const after=tree(home);expect(runUserUninstall({target:'both',env}).exitCode).toBe(0);expect(tree(home)).toBe(after);
}));
test('target codex retains Claude and shared profile configuration',()=>fixture((home,env)=>{
 rhWritesInputMode(env,join(home,'.codex/config.toml'));
 put(home,'.claude/settings.json',JSON.stringify({hooks:buildManagedHooks('claude')}));
 put(home,'.repo-harness/config.json','{"security":{"mode":"strict"}}');
 const claude=readFileSync(join(home,'.claude/settings.json'),'utf8');
 expect(runUserUninstall({target:'codex',env}).exitCode).toBe(0);
 expect(readFileSync(join(home,'.claude/settings.json'),'utf8')).toBe(claude);expect(existsSync(join(home,'.repo-harness/config.json'))).toBe(true);
}));
const TRUST_NOTE='Codex keeps its hook trust entries in [hooks.state]; rh does not remove them.';
test('unrecorded TOML stays untouched beside a hook trust note',()=>fixture((home,env)=>{
 const raw='default_mode_request_user_input = true\n[hooks.state]\nopaque = true\n';put(home,'.codex/config.toml',raw);
 const result=runUserUninstall({target:'both',env});expect(result.exitCode).toBe(0);expect(readFileSync(join(home,'.codex/config.toml'),'utf8')).toBe(raw);expect(result.lines).toContain(`[note] ${join(home,'.codex/config.toml')}: ${TRUST_NOTE}`);
}));
test('hook trust entries alone are a note: uninstall completes and retires install state',()=>fixture((home,env)=>{
 put(home,'.codex/config.toml','[hooks.state."hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:a"\n');
 profile(home,[]);
 const result=runUserUninstall({target:'both',env});
 expect(result.exitCode,result.lines.join('\n')).toBe(0);expect(result.lines.at(-1)).toBe('[uninstall] complete');
 expect(result.lines.filter((line)=>line.startsWith('[note]'))).toEqual([`[note] ${join(home,'.codex/config.toml')}: ${TRUST_NOTE}`]);
 expect(existsSync(join(home,'.repo-harness/install-state.json'))).toBe(false);
}));
test('CLI dry-run JSON creates no lock, receipt or directories',()=>fixture((home,env)=>{
 const before=tree(home);const result=spawnSync('bun',[CLI,'uninstall','--dry-run','--json'],{env:{...env,BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0'},encoding:'utf8'});
 expect(result.status).toBe(0);expect(JSON.parse(result.stdout).dryRun).toBe(true);expect(tree(home)).toBe(before);
}));
// JSON.parse quotes an identifier only up to a dash, so the JSON rows use an identifier-shaped fake token.
const BROKEN_TOML='k = sk-FAKE-SECRET-12345\n',BROKEN_JSON='{"k": sk_FAKE_SECRET_12345}';
test.each<[string,(home:string,env:NodeJS.ProcessEnv)=>void]>([
 ['config.toml with a ledger record',(home,env)=>{rhWritesInputMode(env,join(home,'.codex/config.toml'));put(home,'.codex/config.toml',BROKEN_TOML);}],
 ['config.toml with a receipt entry',(home)=>{put(home,'.codex/config.toml',BROKEN_TOML);put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path:join(home,'.codex/config.toml'),selector:'mcp_servers.codegraph',before:null,installed:'[mcp_servers.codegraph]\ncommand = "cg"\n',active:true}]}));}],
 ['install state',(home)=>put(home,'.repo-harness/install-state.json',BROKEN_JSON)],
 ['receipt',(home)=>put(home,'.repo-harness/configuration-restore.json',BROKEN_JSON)],
 ['rh config',(home)=>put(home,'.repo-harness/config.json',BROKEN_JSON)],
 ['repository excludes ledger',(home)=>put(home,'.repo-harness/repository-excludes.json',BROKEN_JSON)],
])('no parser message of a broken %s reaches rh uninstall output, text or --json (I1, #3164)',(name,seed)=>fixture((home,env)=>{
 seed(home,env);
 const bunInstall=mkdtempSync(join(tmpdir(),'user-uninstall-bun-'));
 try{
  for(const args of [['uninstall','--json'],['uninstall']]){
   const result=spawnSync('bun',[CLI,...args],{env:{...env,BUN_INSTALL:bunInstall,BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0'},encoding:'utf8'});
   expect(result.status,`${name}: ${args.join(' ')}`).toBe(1);
   expect(result.stdout+result.stderr,`${name}: ${args.join(' ')}`).not.toMatch(/sk[-_]FAKE/);
   if(args.includes('--json')) expect(JSON.parse(result.stdout).items.some((item:{action:string})=>item.action==='unresolved'),name).toBe(true);
  }
 }finally{rmSync(bunInstall,{recursive:true,force:true});}
}),60_000);
test('malformed receipt prevents all mutation',()=>fixture((home,env)=>{
 put(home,'.repo-harness/configuration-restore.json','{"protocol":999}');
 put(home,'.codex/hooks.json',JSON.stringify({hooks:buildManagedHooks('codex')}));
 const before=tree(home);expect(runUserUninstall({target:'both',env}).exitCode).toBe(1);expect(tree(home)).toBe(before);
}));
test('a symlinked host root is followed: rh entries go from the linked hook file, and the link stays',()=>fixture((home,env)=>{
 put(home,'outside/hooks.json',JSON.stringify({hooks:buildManagedHooks('codex')}));symlinkSync(join(home,'outside'),join(home,'.codex'));
 expect(runUserUninstall({target:'both',env}).exitCode).toBe(0);expect(Object.values(JSON.parse(readFileSync(join(home,'outside/hooks.json'),'utf8')).hooks).flat()).toEqual([]);expect(lstatSync(join(home,'.codex')).isSymbolicLink()).toBe(true);
}));

test('restores existing MCP config without deleting sibling registrations or permissions',()=>fixture((home,env)=>{
 const path=join(home,'.claude.json');
 // An earlier rh version replaced the user's server and added the tool rule, and recorded both in its receipt.
 put(home,'.claude.json',JSON.stringify({mcpServers:{codegraph:{command:'new'},user:{command:'keep'}},allowedTools:['user-tool','mcp__codegraph__*']}));
 put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[
  {path,selector:'mcpServers.codegraph',before:JSON.stringify({command:'original'}),installed:JSON.stringify({command:'new'}),active:true},
  {path,selector:'allowedTools.codegraph',before:null,installed:JSON.stringify('mcp__codegraph__*'),active:true}]}));
 // An old Codex receipt entry beside a spelling that the Codex migration rejects: a Claude uninstall leaves both alone.
 const codex=join(home,'.codex/config.toml');const codexEntry={path:codex,selector:'default_mode_request_user_input',before:null,installed:'default_mode_request_user_input = true\n',active:true};
 put(home,'.codex/config.toml','"default_mode_request_user_input" = true\n');
 const receipt=JSON.parse(readFileSync(configurationReceiptPath(home),'utf8'));writeFileSync(configurationReceiptPath(home),JSON.stringify({...receipt,changes:[...receipt.changes,codexEntry]}));
 const result=runUserUninstall({target:'claude',env});expect(result.status,result.lines.join('\n')).toBe('complete');
 expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({mcpServers:{codegraph:{command:'original'},user:{command:'keep'}},allowedTools:['user-tool']});
 expect(readFileSync(codex,'utf8')).toBe('"default_mode_request_user_input" = true\n');
 expect(JSON.parse(readFileSync(configurationReceiptPath(home),'utf8')).changes).toContainEqual(codexEntry);
 expect(runUserUninstall({target:'claude',env}).status).toBe('complete');
}));
test('an old receipt entry whose value the user changed stays and is reported, in the dry run and in the uninstall',()=>fixture((home,env)=>{
 const path=join(home,'.claude.json');const edited=JSON.stringify({mcpServers:{codegraph:{command:'edited'}}});
 put(home,'.claude.json',edited);
 put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path,selector:'mcpServers.codegraph',before:null,installed:JSON.stringify({command:'new'}),active:true}]}));
 const line=`[unresolved] ${path}: changed since rh wrote it; preserved: mcpServers.codegraph`;
 for(const dryRun of [true,false]){const result=runUserUninstall({target:'claude',env,dryRun});expect(result.status,String(dryRun)).toBe('partial');expect(result.lines,String(dryRun)).toContain(line);}
 expect(readFileSync(path,'utf8')).toBe(edited);
}));
test('the migration keeps a container and a file that held only that container before rh',()=>fixture((home,env)=>{
 const path=join(home,'.claude.json');const server={command:'new'};
 for(const before of ['{"theme":"user","mcpServers":{}}','{"mcpServers":{}}']){
  put(home,'.claude.json',before.replace('{}',JSON.stringify({codegraph:server})));
  put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path,selector:'mcpServers.codegraph',before:null,installed:JSON.stringify(server),active:true}]}));
  expect(runUserUninstall({target:'claude',env}).status,before).toBe('complete');
  expect(readFileSync(path,'utf8'),before).toBe(before);
 }
}));
test('restores Codex MCP section while preserving other TOML tables',()=>fixture((home,env)=>{
 const path=join(home,'.codex/config.toml');
 put(home,'.codex/config.toml','model = "user"\n[mcp_servers.other]\ncommand = "keep"\n');
 openHostConfigGate({env}).apply([{path,fragments:[{owner:'architecture',selector:'mcp_servers.codegraph',kind:'add',strategy:tomlFragment,value:'[mcp_servers.codegraph]\ncommand = "cg"\n'}]}]);
 expect(runUserUninstall({target:'codex',env}).status).toBe('complete');
 expect(readFileSync(path,'utf8')).toBe('model = "user"\n[mcp_servers.other]\ncommand = "keep"\n');
}));

/** A protocol 5 state and a `created` core record of each path, as an install leaves them. */
function profile(home: string, entries: readonly { path: string; committed: PathCommitted; kind?: 'user_managed' }[]) {
 const env={HOME:home};
 put(home,relative(home,installStateFixturePath(env)),JSON.stringify({protocol:5,...versions(['architecture']),selection:['architecture'],transaction_id:'fixture',applied_at:new Date().toISOString(),previous:null}));
 seedPathRecords(env,Object.fromEntries(entries.map(({path,committed,kind})=>[pathRecordKey(env,path),{owner:'core',host:pathRecordHost(env,path)!,kind:kind??'created' as const,baseline:{state:'unknown' as const},committed}])));
}
function ownedFile(path: string, content: string) { return {path,committed:{type:'file' as const,sha256:`sha256:${createHash('sha256').update(content).digest('hex')}`}}; }
function ownedLink(path: string, target: string) { return {path,committed:{type:'symlink' as const,target}}; }
/** A protocol 3 state with a manifest section record: the uninstall entry migrates it once. */
function legacyProfile(home: string, path: string, content: string) {
 const entry={owner:'architecture',authority:'repo-harness-install-transaction',removal:'managed-surfaces-only',path,type:'managed-file',content_hash:`sha256:${createHash('sha256').update(content).digest('hex')}`,managed_marker:'codegraph-config-projection',symlink_target:null};
 put(home,relative(home,installStateFixturePath({HOME:home})),JSON.stringify({protocol:3,...versions(['architecture']),selection:['architecture'],transaction_id:'fixture',applied_at:new Date().toISOString(),ownership_manifest:[entry],previous:null}));
}
test('removes profile-owned rules, restores a file that rh replaced, and retires profile but preserves user files',()=>fixture((home,env)=>{
 const path=join(home,'.codex/rules/anti-patterns.md');put(home,'.codex/rules/anti-patterns.md','owned');put(home,'.codex/rules/user.md','user');
 profile(home,[ownedFile(path,'owned')]);
 const agent=join(home,'.claude/agents/explorer.md');put(home,'.claude/agents/explorer.md','mine');
 openHostConfigGate({env}).writePaths([{path:agent,owner:'core',entry:{type:'file',bytes:Buffer.from('rh')},replace:true}]);
 const result=runUserUninstall({target:'both',env});
 expect(result.status).toBe('complete');expect(existsSync(path)).toBe(false);
 expect({action:result.items.find((item)=>item.path===agent)?.action,agent:readFileSync(agent,'utf8'),paths:ledger(home).paths}).toEqual({action:'restored',agent:'mine',paths:{}});
 // The vault copy of the replaced file is retired for a later rh config gc.
 expect(ledger(home).retired.map((entry: {sha256: string})=>entry.sha256)).toContain(`sha256:${createHash('sha256').update('mine').digest('hex')}`);
 expect(readFileSync(join(home,'.codex/rules/user.md'),'utf8')).toBe('user');expect(existsSync(join(home,'.repo-harness/install-state.json'))).toBe(false);
}));
test('modified profile-owned rule remains retryable with ownership retained',()=>fixture((home,env)=>{
 const path=join(home,'.codex/rules/anti-patterns.md');put(home,'.codex/rules/anti-patterns.md','user-edited');profile(home,[ownedFile(path,'owned')]);
 expect(runUserUninstall({target:'both',env}).status).toBe('partial');expect(readFileSync(path,'utf8')).toBe('user-edited');expect(existsSync(join(home,'.repo-harness/install-state.json'))).toBe(true);
 expect(Object.keys(ledger(home).paths)).toEqual([pathRecordKey({HOME:home},path)]);
}));
test('owned symlink removal never follows the skill source',()=>fixture((home,env)=>{
 put(home,'source/SKILL.md','keep');mkdirSync(join(home,'.codex/skills'),{recursive:true});const path=join(home,'.codex/skills/check');symlinkSync(join(home,'source'),path);
 profile(home,[ownedLink(path,join(home,'source'))]);
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');expect(existsSync(path)).toBe(false);expect(readFileSync(join(home,'source/SKILL.md'),'utf8')).toBe('keep');
}));
test('a codex uninstall keeps every claude record under a linked ~/.claude, and no uninstall removes a user-managed file',()=>fixture((home,env)=>{
 const dotfiles=join(home,'dotfiles/claude');mkdirSync(join(dotfiles,'skills'),{recursive:true});symlinkSync(dotfiles,join(home,'.claude'));
 put(home,'source/SKILL.md','keep');const link=join(home,'.claude/skills/check');symlinkSync(join(home,'source'),link);
 const rule=join(home,'.codex/rules/anti-patterns.md');put(home,'.codex/rules/anti-patterns.md','owned');
 const kept=join(home,'.codex/agents/explorer.toml');put(home,'.codex/agents/explorer.toml','mine');
 profile(home,[ownedLink(link,join(home,'source')),ownedFile(rule,'owned'),{...ownedFile(kept,'mine'),kind:'user_managed'}]);
 const key=(path: string)=>pathRecordKey({HOME:home},path);
 expect(runUserUninstall({target:'codex',env}).status).toBe('complete');
 expect([existsSync(rule),lstatSync(link).isSymbolicLink(),readFileSync(kept,'utf8')]).toEqual([false,true,'mine']);
 expect(Object.keys(ledger(home).paths).sort()).toEqual([key(link),key(kept)].sort());
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect([existsSync(link),readFileSync(kept,'utf8'),ledger(home).paths]).toEqual([false,'mine',{}]);
}));
test('a recorded skill under a ~/.claude linked outside HOME is checked beneath that root and goes',()=>fixture((home,env)=>{
 const outside=mkdtempSync(join(tmpdir(),'claude-dotfiles-'));
 try {
  mkdirSync(join(outside,'skills'),{recursive:true});symlinkSync(outside,join(home,'.claude'));
  put(home,'source/SKILL.md','keep');const link=join(home,'.claude/skills/check');symlinkSync(join(home,'source'),link);
  profile(home,[ownedLink(link,join(home,'source'))]);
  const result=runUserUninstall({target:'both',env});
  expect(result.status,result.lines.join('\n')).toBe('complete');expect([existsSync(link),ledger(home).paths]).toEqual([false,{}]);
 } finally { rmSync(outside,{recursive:true,force:true}); }
}));
test('an uninstall keeps a personal file and a foreign skill that a path record names outside every install surface',()=>fixture((home,env)=>{
 const personal=join(home,'.codex/rules/personal.md');const foreign=join(home,'.claude/skills/foreign-skill');
 put(home,'.codex/rules/personal.md','mine');put(home,'.claude/skills/foreign-skill/SKILL.md','mine');
 profile(home,[ownedFile(personal,'mine'),{path:foreign,committed:{type:'directory' as const,sha256:hashManagedTree(foreign)}}]);
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect([readFileSync(personal,'utf8'),readFileSync(join(foreign,'SKILL.md'),'utf8')]).toEqual(['mine','mine']);
}));
// A protocol 4 state comes after the move that gave the ledger its path records, so it has no protocol 1 ledger.
test.each([[3,1],[3,2],[4,2]])('a protocol %i install state with a protocol %i ledger: the dry run writes nothing and reports what the uninstall does',(stateProtocol,ledgerProtocol)=>fixture((home,env)=>{
 const rule=join(home,'.codex/rules/anti-patterns.md');put(home,'.codex/rules/anti-patterns.md','owned');
 rhWritesInputMode(env,join(home,'.codex/config.toml'));
 const lockPath=join(home,'.agents/.skill-lock.json');
 if(stateProtocol===3) recordLegacyInstallOwnership([rule],env);
 else {
  // A protocol 4 staged skill whose Skills CLI lock stanza matches, as a lock restored from a backup does (GK-3222-3).
  put(home,'source/SKILL.md','keep');mkdirSync(join(home,'.agents/skills'),{recursive:true});const staged=join(home,'.agents/skills/think');symlinkSync(join(home,'source'),staged);
  put(home,'.agents/.skill-lock.json',`${JSON.stringify({version:3,skills:{think:{source:'tw93/Waza'},'user-skill':{source:'user/repo'}}},null,2)}\n`);
  profile(home,[ownedFile(rule,'owned'),ownedLink(staged,join(home,'source'))]);
  const state=installStateFixturePath(env);writeFileSync(state,JSON.stringify({...JSON.parse(readFileSync(state,'utf8')),protocol:4,pi_packages:[]}));
 }
 // The ledger as an earlier rh version left it.
 const {paths,retired:_retired,recovery:_recovery,tools:_tools,...text}=ledger(home);
 writeFileSync(join(home,'.repo-harness/config/ledger.json'),JSON.stringify(ledgerProtocol===1?{...text,protocol:1}:{...text,protocol:2,paths}));
 const before=tree(home);
 const dryRun=runUserUninstall({target:'both',dryRun:true,env});
 expect(dryRun.lines).toContain(`[reverted] ${pathRecordKey(env,rule)}: unchanged transaction-owned surface`);
 expect(tree(home)).toBe(before);
 const result=runUserUninstall({target:'both',env});
 expect({exitCode:dryRun.exitCode,items:dryRun.items}).toEqual({exitCode:result.exitCode,items:result.items});
 expect(result.exitCode,result.lines.join('\n')).toBe(0);
 // The protocol 4 state proves no stanza bytes: the move claims no lock stanza, and the uninstall leaves the lock as it was.
 if(stateProtocol===4) expect([dryRun.items.some((item)=>item.path===lockPath),openHostConfigGate({env}).recorded(lockPath),JSON.parse(readFileSync(lockPath,'utf8')).skills])
  .toEqual([false,[],{think:{source:'tw93/Waza'},'user-skill':{source:'user/repo'}}]);
}));
const lockSkills=(lockPath:string)=>JSON.parse(readFileSync(lockPath,'utf8')).skills;
test.each(['gone','edited'] as const)('ownership probes P1 and P2: a lock stanza that the Skills CLI wrote through the gate and that is %s now is never taken out by uninstall',(shape)=>fixture((home,env)=>{
 put(home,'source/SKILL.md','keep');mkdirSync(join(home,'.agents/skills'),{recursive:true});const staged=join(home,'.agents/skills/think');symlinkSync(join(home,'source'),staged);
 profile(home,[ownedLink(staged,join(home,'source'))]);
 const lockPath=join(home,'.agents/.skill-lock.json');put(home,'.agents/.skill-lock.json',`${JSON.stringify({version:3,skills:{'user-skill':{source:'user/repo'}}},null,2)}\n`);
 recordLockEntry(lockPath,env);
 const skills=lockSkills(lockPath);
 const now=shape==='gone'?{'user-skill':skills['user-skill']}:{...skills,think:{source:'tw93/Waza',pinned:true}};
 writeFileSync(lockPath,`${JSON.stringify({version:3,skills:now},null,2)}\n`);
 const first=runUserUninstall({target:'both',env});
 expect([lockSkills(lockPath),openHostConfigGate({env}).recorded(lockPath).length]).toEqual([now,shape==='gone'?0:1]);
 if(shape==='edited'){expect(first.exitCode).not.toBe(0);return;}
 // P1: the stanza that the user registers again after the record went stays through a later uninstall.
 expect(first.exitCode).toBe(0);
 const again={...now,think:{source:'tw93/Waza'}};
 writeFileSync(lockPath,`${JSON.stringify({version:3,skills:again},null,2)}\n`);
 expect(runUserUninstall({target:'both',env}).exitCode).toBe(0);
 expect(lockSkills(lockPath)).toEqual(again);
}));
/** The Skills CLI as the runtime runs it: a delegated writer that adds `think` to the lock. */
function recordLockEntry(lockPath:string,env:NodeJS.ProcessEnv){
 openHostConfigGate({env}).delegate([{path:lockPath,owner:'core',selectors:['skills.think']}],()=>{
  const data=JSON.parse(readFileSync(lockPath,'utf8'));writeFileSync(lockPath,`${JSON.stringify({...data,skills:{...data.skills,think:{source:'tw93/Waza'}}},null,2)}\n`);
 });
}
test('the provider lock under an XDG_STATE_HOME outside HOME loses only the entry that rh recorded; the HOME lock stays',()=>fixture((home,env)=>{
 const state=mkdtempSync(join(tmpdir(),'user-uninstall-state-'));const lockPath=join(state,'skills/.skill-lock.json');
 try {
  put(home,'source/SKILL.md','keep');mkdirSync(join(home,'.agents/skills'),{recursive:true});const path=join(home,'.agents/skills/think');symlinkSync(join(home,'source'),path);
  profile(home,[ownedLink(path,join(home,'source'))]);
  const before=`${JSON.stringify({version:3,skills:{'user-skill':{source:'user/repo'}}},null,2)}\n`;
  put(state,'skills/.skill-lock.json',before);put(home,'.agents/.skill-lock.json','{"skills":{"think":{}}}');
  const xdg={...env,XDG_STATE_HOME:state};
  recordLockEntry(lockPath,xdg);
  expect(runUserUninstall({target:'both',env:xdg}).status).toBe('complete');expect(existsSync(path)).toBe(false);
  expect(readFileSync(lockPath,'utf8')).toBe(before);
  expect(readFileSync(join(home,'.agents/.skill-lock.json'),'utf8')).toBe('{"skills":{"think":{}}}');
 } finally { rmSync(state,{recursive:true,force:true}); }
}));
test.skipIf(process.platform==='win32'||process.getuid?.()===0)('a failed provider lock write keeps the lock record for a retry',()=>fixture((home,env)=>{
 const lockDir=join(home,'.local/state/skills');const lockPath=join(lockDir,'.skill-lock.json');const xdg={...env,XDG_STATE_HOME:join(home,'.local/state')};
 put(home,'source/SKILL.md','keep');mkdirSync(join(home,'.agents/skills'),{recursive:true});const path=join(home,'.agents/skills/think');symlinkSync(join(home,'source'),path);
 profile(home,[ownedLink(path,join(home,'source'))]);
 put(home,'.local/state/skills/.skill-lock.json',JSON.stringify({skills:{'user-skill':{}}}));recordLockEntry(lockPath,xdg);chmodSync(lockDir,0o500);
 expect(runUserUninstall({target:'both',env:xdg}).status).not.toBe('complete');
 expect(openHostConfigGate({env:xdg}).recorded(lockPath).map((record)=>record.selector)).toEqual(['skills.think']);
 chmodSync(lockDir,0o700);
 expect(runUserUninstall({target:'both',env:xdg}).status).toBe('complete');
 expect(JSON.parse(readFileSync(lockPath,'utf8')).skills).toEqual({'user-skill':{}});
}));
const RULES_BLOCK=renderGlobalRulesBlock(join(import.meta.dir,'../..'),{preset:'en',instruction:'Use English to report to user.'}).trimEnd();
test('managed context block cleanup keeps user prose',()=>fixture((home,env)=>{
 put(home,'.codex/AGENTS.md',`user-before\n${RULES_BLOCK}\nuser-after\n`);
 expect(runUserUninstall({target:'codex',env}).status).toBe('complete');expect(readFileSync(join(home,'.codex/AGENTS.md'),'utf8')).toBe('user-before\nuser-after\n');
}));
test('rules blocks revert to the original bytes, keep a later user line and an edited block, and a shared link is one file',()=>fixture((home,env)=>{
 const root=join(import.meta.dir,'../..');const claude=join(home,'.claude/CLAUDE.md');const codex=join(home,'.codex/AGENTS.md');
 const install=()=>expect(applyGlobalContextRefresh(preflightGlobalContextRefresh(root,home,['codex','claude'],'en'),home).status).toBe('ok');
 put(home,'.claude/CLAUDE.md','claude notes');put(home,'.codex/AGENTS.md','codex notes\n');
 install();expect(readFileSync(claude,'utf8')).toBe(`claude notes\n\n${RULES_BLOCK}`);
 const refresh=preflightGlobalContextRefresh(root,home,['claude','codex'],undefined);
 expect(refresh.files.map(({state,outcome})=>[state,outcome])).toEqual([['managed-current','unchanged'],['managed-current','unchanged']]);
 expect(applyGlobalContextRefresh(refresh,home).status).toBe('ok');
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect([readFileSync(claude,'utf8'),readFileSync(codex,'utf8')]).toEqual(['claude notes','codex notes\n']);
 expect(existsSync(join(home,'.repo-harness/global-context-backups'))).toBe(false);
 install();appendFileSync(codex,'later\n');writeFileSync(claude,readFileSync(claude,'utf8').replace('## Reporting','- My own rule.\n\n## Reporting'));
 const edited=readFileSync(claude,'utf8');const result=runUserUninstall({target:'both',env});
 expect(readFileSync(codex,'utf8')).toBe('codex notes\nlater\n');expect(readFileSync(claude,'utf8')).toBe(edited);
 expect(result.lines).toContain(`[unresolved] ${claude}: changed since rh wrote it; preserved: global-working-rules`);
 rmSync(claude);symlinkSync(codex,claude);install();
 expect(readFileSync(codex,'utf8').split(RULES_BLOCK)).toHaveLength(2);
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect(readFileSync(codex,'utf8')).toBe('codex notes\nlater\n');expect(lstatSync(claude).isSymbolicLink()).toBe(true);
}));
/** Every entry outside ~/.repo-harness and ~/.bun, with the bytes and mode of each file. */
function hostSnapshot(home: string) {
 return readdirSync(home,{recursive:true}).map(String).filter((p)=>!/^\.(repo-harness|bun)([\\/]|$)/.test(p)).sort().map((p)=>{
  const stat=lstatSync(join(home,p));return stat.isFile()?[p,stat.mode&0o777,readFileSync(join(home,p),'utf8')]:[p,stat.isDirectory()?'dir':'other'];
 });
}
test('install then uninstall leaves the six host text files byte-identical with their modes, and nothing new outside ~/.repo-harness',()=>withTempHome('host-config-roundtrip',(home)=>{
 const env={...process.env};const root=join(import.meta.dir,'../..');
 const seeds:Record<string,[string,number]>={'.codex/config.toml':['model = "user"\n',0o644],'.codex/hooks.json':['{\n  "hooks": {}\n}\n',0o644],
  '.claude/settings.json':['{\n  "theme": "dark"\n}\n',0o640],'.claude.json':['{\n  "user": 1\n}',0o644],'.claude/CLAUDE.md':['claude notes\n',0o644],'.codex/AGENTS.md':['codex notes',0o600]};
 for(const [path,[content,mode]] of Object.entries(seeds)){put(home,path,content);chmodSync(join(home,path),mode);}
 const before=hostSnapshot(home);
 expect(runInstall({target:'both',location:'global'}).exitCode).toBe(0);
 openHostConfigGate({env}).apply([{path:join(home,'.claude.json'),backup:CLAUDE_ROOT_CONFIG_BACKUP,fragments:[{owner:'architecture',selector:CODEGRAPH_MCP_SELECTOR,kind:'add',strategy:jsonFragment,value:{command:'codegraph'}}]}]);
 expect(applyGlobalContextRefresh(preflightGlobalContextRefresh(root,home,['codex','claude'],'en'),home).status).toBe('ok');
 for(const path of Object.keys(seeds)) expect(readFileSync(join(home,path),'utf8'),path).not.toBe(seeds[path]![0]);
 const result=runUserUninstall({target:'both',env});
 expect(result.exitCode,result.lines.join('\n')).toBe(0);
 expect(Object.keys(seeds).map((path)=>result.items.find((item)=>item.path===join(home,path))?.action)).toEqual(Object.keys(seeds).map(()=>'restored'));
 expect(hostSnapshot(home)).toEqual(before);
}));
test('uninstall retires a deleted rules file record without restoring the file',()=>fixture((home,env)=>{
 const path=join(home,'.claude/CLAUDE.md');
 put(home,'.claude/CLAUDE.md','user notes');
 const plan=preflightGlobalContextRefresh(join(import.meta.dir,'../..'),home,['claude'],'en');
 expect(applyGlobalContextRefresh(plan,home).status).toBe('ok');
 const before=ledger(home);
 rmSync(path);
 const dryRun=runUserUninstall({target:'claude',env,dryRun:true});
 expect(dryRun.exitCode).toBe(0);
 expect(dryRun.lines).toContain(`[note] ${path}: file already absent`);
 expect(ledger(home)).toEqual(before);
 const result=runUserUninstall({target:'claude',env});
 expect(result.exitCode).toBe(0);
 expect(result.items).toEqual(dryRun.items);
 expect(existsSync(path)).toBe(false);
 const {files,fragments}=ledger(home);
 expect({files,fragments}).toEqual({files:{},fragments:[]});
}));
test.each(['deleted','dangling link'] as const)('a %s config.toml with an active legacy receipt plans the same in the dry run and in the uninstall',(shape)=>fixture((home,env)=>{
 const path=join(home,'.codex/config.toml');
 put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path,selector:'default_mode_request_user_input',before:null,installed:'default_mode_request_user_input = true\n',active:true}]}));
 // A dangling link is still there, so its file is not absent: the records stay, in the preview as in the apply.
 const target=join(home,'dotfiles/config.toml');
 if(shape==='dangling link'){mkdirSync(join(home,'.codex'),{recursive:true});symlinkSync(target,path);}
 const dryRun=runUserUninstall({target:'codex',env,dryRun:true});
 expect(dryRun.lines).toContain(shape==='deleted'?`[note] ${path}: file already absent`:`[unresolved] ${target}: changed since rh wrote it; preserved: default_mode_request_user_input`);
 const result=runUserUninstall({target:'codex',env});
 expect({status:result.status,items:result.items}).toEqual({status:dryRun.status,items:dryRun.items});
 expect({status:result.status,link:lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink()??false}).toEqual(shape==='deleted'?{status:'complete',link:false}:{status:'partial',link:true});
}));
test('a revert whose result would not equal the known baseline writes nothing, exits 2 and keeps the install state, the record and its vault copy',()=>fixture((home,env)=>{
 const path=join(home,'.codex/config.toml');put(home,'.codex/config.toml','model = "user"\n');
 rhWritesInputMode(env,path);
 profile(home,[]);
 const written=readFileSync(path,'utf8');const recorded=ledger(home);
 // A ledger whose baseline does not match the reverted bytes, as a wrong strategy result would give.
 const wrong={...recorded,files:{[path]:{...recorded.files[path],baseline:{state:'known',existed:true,sha256:`sha256:${'1'.repeat(64)}`}}}};
 writeFileSync(join(home,'.repo-harness/config/ledger.json'),JSON.stringify(wrong));
 put(home,'.codex/rules/anti-patterns.md','edited');seedPathRecords({HOME:home},{[pathRecordKey(env,join(home,'.codex/rules/anti-patterns.md'))]:{owner:'core',host:'codex',kind:'created',baseline:{state:'unknown'},committed:ownedFile('','owned').committed}});
 const result=runUserUninstall({target:'both',env});
 expect({exitCode:result.exitCode,status:result.status}).toEqual({exitCode:2,status:'failed'});
 expect(result.lines).toContain(`[failed] ${path}: host_config_restore_mismatch: the reverted file would not equal the file before rh; nothing written, the ledger record and its vault copy kept`);
 expect(result.items.some((item)=>item.action==='unresolved')).toBe(true);
 expect([readFileSync(path,'utf8'),ledger(home).files[path],existsSync(join(home,'.repo-harness/install-state.json'))]).toEqual([written,wrong.files[path],true]);
 expect(readdirSync(join(home,'.repo-harness/config/vault'))).toContain(String(wrong.files[path].backup).slice('sha256:'.length));
}));
test('--remove-edited-block takes out an edited rules block after a whole-file copy; the dry run copies nothing, and an unbalanced block is kept',()=>fixture((home,env)=>{
 const path=join(home,'.claude/CLAUDE.md');put(home,'.claude/CLAUDE.md','claude notes');
 expect(applyGlobalContextRefresh(preflightGlobalContextRefresh(join(import.meta.dir,'../..'),home,['claude'],'en'),home).status).toBe('ok');
 writeFileSync(path,readFileSync(path,'utf8').replace('## Reporting','- My own rule.\n\n## Reporting')+'\nlater\n');
 const edited=readFileSync(path,'utf8');const vault=join(home,'.repo-harness/config/vault');const copies=()=>existsSync(vault)?readdirSync(vault).sort():[];const before=copies();
 const dryRun=runUserUninstall({target:'claude',env,dryRun:true,removeEditedBlocks:[path]});
 expect([dryRun.exitCode,readFileSync(path,'utf8'),copies()]).toEqual([0,edited,before]);
 const result=runUserUninstall({target:'claude',env,removeEditedBlocks:[path]});
 expect(result.exitCode,result.lines.join('\n')).toBe(0);
 expect(readFileSync(path,'utf8')).toBe('claude notes\nlater\n');
 const copy=ledger(home).recovery[0].sha256.slice('sha256:'.length);
 expect(result.lines).toContain(`[reverted] ${path}: the global-working-rules block went on your word; whole-file copy: ${join(vault,copy)}`);
 expect(readFileSync(join(vault,copy),'utf8')).toBe(edited);
 expect(ledger(home).files).toEqual({});
 // An unbalanced block: no copy and no write.
 expect(applyGlobalContextRefresh(preflightGlobalContextRefresh(join(import.meta.dir,'../..'),home,['claude'],'en'),home).status).toBe('ok');
 appendFileSync(path,'\n<!-- END: repo-harness global-working-rules -->\n');
 const unbalanced=readFileSync(path,'utf8');const kept=copies();
 const refused=runUserUninstall({target:'claude',env,removeEditedBlocks:[path]});
 expect([refused.exitCode,readFileSync(path,'utf8'),copies()]).toEqual([1,unbalanced,kept]);
}));
test.each([
 ['.claude/CLAUDE.md',`user-before\n${RULES_BLOCK.replace('## Reporting','- My own rule.\n\n## Reporting')}\n`,'managed rules block'],
])('an edited managed block in %s keeps the file byte-identical and is unresolved',(path,content,name)=>fixture((home,env)=>{
 put(home,path,content);
 const result=runUserUninstall({target:'both',env});
 expect(result.exitCode).toBe(1);expect(readFileSync(join(home,path),'utf8')).toBe(content);
 expect(result.lines).toContain(`[unresolved] ${join(home,path)}: ${name} was edited; preserved. Move your rules outside the markers, then delete the block.`);
}));

test('old transaction-owned MCP projection composes with hook removal',()=>fixture((home,env)=>{
 const path=join(home,'.claude/settings.json');
 const server={command:'cg'};const allowedTools=['user-tool','mcp__codegraph__*'];
 put(home,'.claude/settings.json',JSON.stringify({mcpServers:{codegraph:server,user:{command:'keep'}},allowedTools,hooks:buildManagedHooks('claude')}));
 const projection=JSON.stringify({server,allowedTools:['mcp__codegraph__*']});
 legacyProfile(home,path,projection);
 const result=runUserUninstall({target:'both',env});expect(result.status,result.lines.join('\n')).toBe('complete');
 expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({mcpServers:{user:{command:'keep'}},allowedTools:['user-tool'],hooks:Object.fromEntries(Object.keys(buildManagedHooks('claude')).map(event=>[event,[]]))});
}));
test('a reverted record cannot delete a user same-value setting after no-op reinstall',()=>fixture((home,env)=>{
 const path=join(home,'.codex/config.toml');
 rhWritesInputMode(env,path);
 expect(runUserUninstall({target:'codex',env}).status).toBe('complete');
 put(home,'.codex/config.toml','default_mode_request_user_input = true\n');
 // A user's `true` gives no request, so rh takes no new ownership.
 expect(requestUserInputFragment(readFileSync(path,'utf8'))).toBeNull();
 const result=runUserUninstall({target:'codex',env});
 expect(readFileSync(path,'utf8')).toContain('true');expect(result.status).toBe('complete');
}));
test('an old manifest record of the Codex CodeGraph table migrates to the ledger and uninstall removes the table',()=>{
 // The old manifest matched an indented header too.
 for(const table of ['[mcp_servers.codegraph]\ncommand = "cg"\n','  [mcp_servers.codegraph]\ncommand = "cg"\n'])fixture((home,env)=>{
  const path=join(home,'.codex/config.toml');
  put(home,'.codex/config.toml',`model = "user"\n${table}`);
  legacyProfile(home,path,table.trim());
  const result=runUserUninstall({target:'both',env});expect(result.status,result.lines.join('\n')).toBe('complete');
  // An adopted record has no baseline, so the report says that equality with the file before install cannot be proved.
  expect(result.items.find((item)=>item.path===path)).toEqual({path,action:'reverted',reason:'host-config ledger: rh text removed; baseline unknown: equality with the file before install cannot be proved'});
  expect(readFileSync(path,'utf8')).toBe('model = "user"\n');expect(existsSync(join(home,'.repo-harness/install-state.json'))).toBe(false);
 });
});

/** The entries outside ~/.repo-harness/, where an uninstall keeps its own state. */
function hostTree(home:string){return readdirSync(home,{recursive:true}).map(String).filter((path)=>!path.startsWith('.repo-harness')).sort().map((path)=>{const stat=lstatSync(join(home,path));return stat.isFile()?`${path}:${createHash('sha256').update(readFileSync(join(home,path))).digest('hex')}`:path;}).join('\n');}
/** The hc step of a fresh install from a fake pinned release: the real producer of the herdr-core tool record. */
async function installHerdrCore(root:string,env:NodeJS.ProcessEnv,windows:boolean){
 const pkg=join(root,'pkg'),release=join(root,'release');mkdirSync(pkg);mkdirSync(release);
 writeFileSync(join(pkg,windows?'herdr-core.exe':'herdr-core'),`#!/bin/sh\necho "hc ${HC_MIN_VERSION}"\n`,{mode:0o755});
 if(windows){mkdirSync(join(pkg,'conpty'));writeFileSync(join(pkg,'conpty','conpty.dll'),'dll\n');writeFileSync(join(env.SystemRoot!,'System32','tar.exe'),'#!/bin/sh\nexec tar "$@"\n',{mode:0o755});}
 expect(spawnSync('tar',['-czf',join(release,'asset'),'-C',pkg,'.']).status).toBe(0);
 const server=startFakeHcRelease(root,release);
 try{
  const asset={url:`http://127.0.0.1:${await server.port}/asset`,sha256:createHash('sha256').update(readFileSync(join(release,'asset'))).digest('hex')};
  const {step}=ensureHerdrCore({cwd:root,env,command:'install',platform:windows?'win32-x64':'darwin-arm64',minVersion:HC_MIN_VERSION,assets:{'macos-aarch64':asset,'windows-x86_64':asset}});
  expect(step.status,step.detail).toBe('ok');
 }finally{server.stop();}
}
test.each([
 {platform:'unix',edited:false},{platform:'windows',edited:false},
 {platform:'unix',edited:true},{platform:'windows',edited:true},
])('a fresh hc install: the default uninstall keeps it with one kept line; --with-tools removes only unchanged entries ($platform, edited $edited)',async({platform,edited})=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'user-uninstall-tools-'))),home=join(root,'home'),windows=platform==='windows';
 const systemRoot=join(root,'Windows'),registry=join(root,'registry.json');
 mkdirSync(home);mkdirSync(join(systemRoot,'System32'),{recursive:true});
 const env:NodeJS.ProcessEnv={...process.env,HOME:home,GIT_CONFIG_NOSYSTEM:'1',PATH:'/usr/bin:/bin',SystemRoot:systemRoot,LOCALAPPDATA:join(home,'AppData','Local')};delete env.XDG_STATE_HOME;delete env.XDG_CONFIG_HOME;
 writeFakeUserPathPowershell(join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),registry,join(root,'powershell.log'));
 const userPath={existed:true,kind:'ExpandString',raw:'%USERPROFILE%\\bin'};writeFileSync(registry,JSON.stringify(userPath));
 const dir=windows?join(home,'AppData','Local','Programs','herdr-core'):join(home,'.local','bin');
 try{
  await installHerdrCore(root,env,windows);
  const installed=hostTree(home),registryInstalled=readFileSync(registry,'utf8');
  const kept=runUserUninstall({target:'both',env});
  expect(kept.items.filter((item)=>item.action==='kept'&&item.reason.startsWith('shared tools'))).toEqual([{path:join(home,'.repo-harness/config/ledger.json'),action:'kept',
   reason:`shared tools that rh installed stay: herdr-core ${HC_MIN_VERSION} (${windows?'herdr-core.exe, conpty, hc.exe) and its user PATH entry':'herdr-core, hc)'}; remove herdr-core with: rh uninstall --with-tools`}]);
  expect([kept.exitCode,hostTree(home),readFileSync(registry,'utf8')]).toEqual([0,installed,registryInstalled]);
  if(edited&&windows)writeFileSync(registry,JSON.stringify({...userPath,raw:`${userPath.raw};${dir.toUpperCase()}`}));
  if(edited&&!windows){appendFileSync(join(dir,'herdr-core'),'# user patch\n');writeFileSync(join(dir,'other-tool'),'user\n');}
  expect(runUninstall({target:'codex',location:'global',withTools:true,env} as never).exitCode).toBe(2);
  const before=hostTree(home),registryBefore=readFileSync(registry,'utf8');
  const preview=runUserUninstall({target:'both',env,withTools:true,dryRun:true});
  expect([hostTree(home),readFileSync(registry,'utf8')]).toEqual([before,registryBefore]);
  const removed=runUserUninstall({target:'both',env,withTools:true});
  expect({exitCode:preview.exitCode,items:preview.items}).toEqual({exitCode:removed.exitCode,items:removed.items});
  const tool=(path:string)=>removed.items.find((item)=>item.path===path)?.action;
  if(!edited){
   expect(removed.exitCode,removed.lines.join('\n')).toBe(0);
   // Nothing that the hc step created stays: the install dir, the directories above it that it created, and the PATH entry.
   expect(existsSync(windows?join(home,'AppData'):join(home,'.local'))).toBe(false);
   expect(JSON.parse(readFileSync(registry,'utf8'))).toEqual(userPath);
   expect(ledger(home).tools).toEqual({});
  }else if(windows){
   expect([removed.exitCode,existsSync(dir),tool(`HKCU\\Environment\\Path: ${dir}`)]).toEqual([1,false,'unresolved']);
   expect(readFileSync(registry,'utf8')).toBe(registryBefore);
   expect(Object.keys(ledger(home).tools['herdr-core'])).toContain('path_entry');
  }else{
   // The changed binary and the user's file stay; the unchanged link goes.
   expect([removed.exitCode,tool(join(dir,'herdr-core')),tool(join(dir,'hc')),tool(dir),readdirSync(dir).sort()]).toEqual([1,'unresolved','restored','kept',['herdr-core','other-tool']]);
   expect(Object.keys(ledger(home).tools['herdr-core'].paths)).toEqual([join(dir,'herdr-core')]);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},30_000);
