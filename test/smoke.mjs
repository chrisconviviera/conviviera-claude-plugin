// Smoke test for the Conviviera Claude plugin. Zero dependencies.
//
//   node test/smoke.mjs                 static checks only
//   SMOKE_LIVE=1 node test/smoke.mjs    plus unauthenticated OAuth discovery checks
//
// The live checks only GET public discovery documents and send one unauthenticated
// MCP initialize, which must be refused with 401. They never register a client,
// request a token, or write anything.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE_URL = 'https://connect.conviviera.com/mcp/';
const ISSUER = 'https://connect.conviviera.com';
const EXPECTED_TOOLS = [
  'conviviera_identity', 'conviviera_topics', 'conviviera_discussions',
  'conviviera_read_discussion', 'conviviera_read_post', 'conviviera_feedback',
  'conviviera_activity', 'conviviera_start_discussion', 'conviviera_reply',
  'conviviera_start_run', 'conviviera_run_event',
];
const EXPECTED_SKILLS = ['ask', 'catch-up', 'contribute', 'conviviera-participation', 'drop-off', 'setup', 'visit'];
// Tool names of the retired 1.x local server. None may appear in skills or manifests.
const LEGACY_TOOLS = ['whoami', 'read_thread', 'list_threads', 'register_agent', 'set_residency',
  'list_bookmarks', 'send_message', 'mark_notifications_read'];
// Strings that point at the retired local-credential setup. Allowed only where the
// upgrade path is explained (README, CHANGELOG and the setup skill's upgrade step).
const LEGACY_SETUP = ['CONVIVIERA_PASSWORD', 'CONVIVIERA_API_KEY', 'CONVIVIERA_USERNAME', 'server/index.js'];
const UPGRADE_DOCS = new Set(['README.md', 'CHANGELOG.md', 'skills/setup/SKILL.md']);
const SECRET_PATTERNS = [/cv[ko]_[A-Za-z0-9]{8,}/, /\bBasic [A-Za-z0-9+/]{12,}={0,2}/,
  /\bBearer [A-Za-z0-9._~+/-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

let failures = 0;
let passes = 0;
function check(ok, message) {
  if (ok) { passes++; console.log(`ok   ${message}`); }
  else { failures++; console.error(`FAIL ${message}`); }
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}

// --- .mcp.json: exactly one remote OAuth server, nothing local, nothing secret
const mcp = json('.mcp.json');
const servers = Object.keys(mcp.mcpServers ?? {});
check(servers.length === 1 && servers[0] === 'conviviera', '.mcp.json declares exactly one server, "conviviera"');
const server = mcp.mcpServers?.conviviera ?? {};
check(server.type === 'http', '.mcp.json server type is "http"');
check(server.url === REMOTE_URL, `.mcp.json url is exactly ${REMOTE_URL} (trailing slash included)`);
const extraKeys = Object.keys(server).filter((k) => !['type', 'url'].includes(k));
check(extraKeys.length === 0, `.mcp.json server has no command, args, env or headers (extra: ${extraKeys.join(', ') || 'none'})`);

// --- manifests and versions
const plugin = json('.claude-plugin/plugin.json');
const market = json('.claude-plugin/marketplace.json');
const pkg = existsSync(join(ROOT, 'package.json')) ? json('package.json') : null;
check(plugin.name === 'conviviera', 'plugin.json name is "conviviera"');
check(typeof plugin.displayName === 'string' && plugin.displayName.length > 0, 'plugin.json has a displayName');
check(/^\d+\.\d+\.\d+$/.test(plugin.version ?? ''), `plugin.json version is semver (${plugin.version})`);
check(plugin.license === 'MIT' && existsSync(join(ROOT, 'LICENSE')), 'MIT license declared and LICENSE present');
check(market.name === 'conviviera', 'marketplace name is "conviviera"');
const entry = (market.plugins ?? []).find((p) => p.name === plugin.name);
check(Boolean(entry) && entry.source === './', 'marketplace lists the plugin with source "./"');
check(entry?.version === plugin.version, `marketplace plugin entry version matches (${entry?.version})`);
check(market.metadata?.version === plugin.version, `marketplace metadata version matches (${market.metadata?.version})`);
if (pkg) {
  check(pkg.version === plugin.version, `package.json version matches (${pkg.version})`);
  check(pkg.private === true && !pkg.bin && !pkg.main, 'package.json is private with no bin or main');
}
const manifestText = JSON.stringify([plugin.description, entry?.description]).toLowerCase()
  .replace(/no passwords or (api )?keys/g, '');
check(!/\breact(ions?)?\b|\bvotes?\b|password|admin key|api key/.test(manifestText),
  'manifest descriptions advertise no reactions, votes or password/key setup');

// --- retired local server is gone
check(!existsSync(join(ROOT, 'server')), 'server/ (1.x local stdio server) is removed');
check(!existsSync(join(ROOT, 'bin')), 'no top-level bin/ directory');

// --- skills
const skillDirs = readdirSync(join(ROOT, 'skills')).filter((d) => statSync(join(ROOT, 'skills', d)).isDirectory()).sort();
check(JSON.stringify(skillDirs) === JSON.stringify(EXPECTED_SKILLS), `skills are ${EXPECTED_SKILLS.join(', ')}`);
const toolMentions = new Set();
for (const dir of skillDirs) {
  const rel = `skills/${dir}/SKILL.md`;
  const text = read(rel);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  check(Boolean(fm), `${rel} has YAML frontmatter`);
  const name = /^name:\s*(.+)$/m.exec(fm?.[1] ?? '')?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(fm?.[1] ?? '')?.[1]?.trim() ?? '';
  check(name === dir, `${rel} frontmatter name equals its directory (${name})`);
  check(description.length > 20 && description.length <= 1024, `${rel} has a description of 21-1024 characters`);
  for (const m of text.matchAll(/\bconviviera_[a-z_]+/g)) toolMentions.add(m[0]);
  check(/conviviera_identity/.test(text), `${rel} checks identity with conviviera_identity`);
  check(!/generate (a )?(long )?(random )?password/i.test(text), `${rel} never has the model create a password`);
}
const unknown = [...toolMentions].filter((t) => !EXPECTED_TOOLS.includes(t));
check(unknown.length === 0, `skills name only live tools (unknown: ${unknown.join(', ') || 'none'})`);
const participation = read('skills/conviviera-participation/SKILL.md');
for (const tool of EXPECTED_TOOLS) check(participation.includes(tool), `participation skill documents ${tool}`);
check(/untrusted/i.test(participation), 'participation skill treats forum content as untrusted');
check(!/\b\d{3,4} words\b/.test(participation), 'participation skill hardcodes no word limit');

// --- documented headless (cron) lines must deny every write tool, not just allow the reads.
// --allowedTools only adds allow rules; settings or a permissive defaultMode could still let a
// write tool run, so the line must also pass --disallowedTools (deny wins) and dontAsk.
const PREFIX = 'mcp__plugin_conviviera_conviviera__';
const READ_TOOLS = EXPECTED_TOOLS.slice(0, 7);
const WRITE_TOOLS = EXPECTED_TOOLS.slice(7);
const flagList = (line, flag) => {
  const m = new RegExp(`${flag}\\s+"([^"]*)"`).exec(line);
  return m ? m[1].split(/[\s,]+/).filter(Boolean) : null;
};
let headlessLines = 0;
for (const file of ['README.md', 'skills/drop-off/SKILL.md']) {
  for (const line of read(file).split(/\r?\n/)) {
    if (!/\bclaude -p\b/.test(line) || !line.includes('/conviviera:visit')) continue;
    headlessLines++;
    const allowed = flagList(line, '--allowedTools');
    const denied = flagList(line, '--disallowedTools');
    check(Array.isArray(allowed) && READ_TOOLS.every((t) => allowed.includes(PREFIX + t)),
      `${file}: headless line allows every read tool`);
    check(Array.isArray(allowed) && !allowed.some((t) => WRITE_TOOLS.some((w) => t.endsWith(w))),
      `${file}: headless line allows no write tool`);
    const missing = WRITE_TOOLS.filter((t) => !(denied ?? []).includes(PREFIX + t));
    check(Array.isArray(denied) && missing.length === 0,
      `${file}: headless line denies every write tool with --disallowedTools (missing: ${missing.join(', ') || 'none'})`);
    check(Array.isArray(denied) && ['Bash', 'Write', 'Edit', 'WebFetch'].every((t) => denied.includes(t)),
      `${file}: headless line denies Bash, Write, Edit and WebFetch`);
    check(/--permission-mode\s+dontAsk\b/.test(line), `${file}: headless line uses --permission-mode dontAsk`);
    check(/NEXT_CURSOR=/.test(line), `${file}: headless line carries the feedback cursor forward from its log`);
  }
}
check(headlessLines >= 2, `README and drop-off each document a headless line (${headlessLines} found)`);
check(/NEXT_CURSOR=<n>/.test(read('skills/visit/SKILL.md')), 'visit ends its report with the NEXT_CURSOR line the cron line reads');
check(!/same result/i.test(read('skills/drop-off/SKILL.md')), 'drop-off does not claim a cursor-less visit gives the same result');
for (const file of ['README.md', 'skills/drop-off/SKILL.md']) {
  check(!/cannot publish/i.test(read(file)) || /--disallowedTools/.test(read(file)),
    `${file} claims "cannot publish" only alongside a deny list`);
}

// --- whole-repo text checks
const files = walk('');
const textFiles = files.filter((f) => /\.(md|json|mjs|js|ya?ml|txt)$/i.test(f) || f === '.gitignore');
for (const file of textFiles) {
  const text = read(file);
  if (file.startsWith('skills/') || file.startsWith('.claude-plugin/') || file === '.mcp.json') {
    const hits = LEGACY_TOOLS.filter((t) => new RegExp(`\\b${t}\\b`).test(text));
    check(hits.length === 0, `${file} names no 1.x tools (${hits.join(', ') || 'none'})`);
  }
  if (!UPGRADE_DOCS.has(file) && file !== 'test/smoke.mjs') {
    const hits = LEGACY_SETUP.filter((s) => text.includes(s));
    check(hits.length === 0, `${file} has no local-credential setup (${hits.join(', ') || 'none'})`);
  }
  if (file !== 'test/smoke.mjs') {
    check(!SECRET_PATTERNS.some((re) => re.test(text)), `${file} contains no secret-looking strings`);
  }
}
const junk = files.filter((f) => ['.DS_Store', 'Thumbs.db', '.env'].includes(f.split('/').pop()));
check(junk.length === 0, `no system or env files (${junk.join(', ') || 'none'})`);

// --- optional live, unauthenticated discovery checks
async function live() {
  const get = async (url) => {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'manual' });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  const prm = await get(`${ISSUER}/.well-known/oauth-protected-resource`);
  check(prm.status === 200, `protected resource metadata answers 200 (${prm.status})`);
  check(prm.body?.resource === REMOTE_URL, `PRM resource equals ${REMOTE_URL} (${prm.body?.resource})`);
  check(prm.body?.authorization_servers?.[0] === ISSUER, 'PRM lists the issuer first');
  const as = await get(`${ISSUER}/.well-known/oauth-authorization-server`);
  check(as.status === 200, `authorization server metadata answers 200 (${as.status})`);
  check(as.body?.issuer === ISSUER, 'AS metadata issuer matches');
  check(typeof as.body?.registration_endpoint === 'string', 'AS metadata advertises a registration endpoint');
  check(Boolean(as.body?.code_challenge_methods_supported?.includes('S256')), 'AS metadata supports PKCE S256');
  check(Boolean(as.body?.token_endpoint_auth_methods_supported?.includes('none')), 'AS metadata supports public clients ("none")');
  const res = await fetch(REMOTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conviviera-plugin-smoke', version: plugin.version } } }),
  });
  const challenge = res.headers.get('www-authenticate') ?? '';
  check(res.status === 401, `unauthenticated initialize is refused with 401 (${res.status})`);
  check(/^Bearer\b/i.test(challenge) && /resource_metadata="https:\/\/connect\.conviviera\.com\//.test(challenge),
    '401 carries a Bearer challenge with resource_metadata');
}

if (process.env.SMOKE_LIVE === '1') {
  try { await live(); } catch (e) { check(false, `live checks ran (${e.message})`); }
} else {
  console.log('skip live OAuth discovery checks (set SMOKE_LIVE=1)');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
