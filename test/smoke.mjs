// End-to-end smoke test: speaks MCP over stdio to the server and exercises the
// tools against CONVIVIERA_URL (a local fixture or the live site).
// Usage: CONVIVIERA_URL=http://127.0.0.1:8098 CONVIVIERA_API_KEY=cvk_… node test/smoke.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js');
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const tool = async (name, args) => {
  const r = await call('tools/call', { name, arguments: args || {} });
  if (r.error) throw new Error(`${name}: rpc error ${JSON.stringify(r.error)}`);
  return r.result;
};
let passed = 0;
const check = (cond, label) => { if (!cond) { console.error('FAIL', label); process.exitCode = 1; child.kill(); process.exit(1); } passed++; };
const writes = process.env.SMOKE_WRITES === '1';

const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
check(init.result?.protocolVersion === '2025-06-18' && init.result.serverInfo.name === 'conviviera', 'initialize');
notify('notifications/initialized');
check((await call('ping')).result !== undefined, 'ping');
const list = await call('tools/list');
const names = list.result.tools.map((t) => t.name);
check(names.includes('reply') && names.includes('read_thread') && names.includes('register_agent'), 'tools/list ' + names.length + ' tools');
for (const t of list.result.tools) check(t.inputSchema && t.inputSchema.type === 'object' && t.description, 'schema ' + t.name);
const bad = await call('tools/call', { name: 'nope', arguments: {} });
check(bad.error && bad.error.code === -32602, 'unknown tool is a JSON-RPC error');
const prompts = await call('prompts/list');
check(prompts.result.prompts.some((p) => p.name === 'contribute'), 'prompts/list');
const got = await call('prompts/get', { name: 'contribute', arguments: { thread_id: '4' } });
check(got.result.messages[0].content.text.includes('discussion 4'), 'prompts/get renders arguments');
const res = await call('resources/list');
check(res.result.resources[0].uri === 'conviviera://guide', 'resources/list');

const guide = await tool('guide');
check(!guide.isError && /Conviviera/.test(guide.content[0].text), 'guide tool (unauthenticated)');
const who = await tool('whoami');
const authed = !who.isError && /authentication succeeded/.test(who.content[0].text);
console.log('whoami:', who.content[0].text.split('\n').slice(0, 2).join(' | '));
if (!authed) {
  check(/No Conviviera credentials/.test(who.content[0].text), 'whoami explains setup without credentials');
  const r = await tool('categories');
  check(r.isError && /credentials/.test(r.content[0].text), 'authenticated tools fail gracefully without credentials');
} else {
  const toon = process.env.CONVIVIERA_FORMAT !== 'json';
  const cats = await tool('categories');
  check(!cats.isError && (toon ? /^categories\[\d+\]\{id,name,slug,blurb,agent_word_limit\}:/m.test(cats.content[0].text) : cats.structuredContent.categories.length > 0), 'categories' + (toon ? ' arrive as a TOON table' : ''));
  const threads = await tool('list_threads', { limit: 5 });
  let first;
  if (toon) {
    const text = threads.content[0].text;
    const header = text.match(/^threads\[(\d+)\]\{([^}]+)\}:$/m);
    check(!threads.isError && header, 'list_threads arrives as a TOON table');
    const fields = header[2].split(',');
    const rows = text.split('\n').slice(1, 1 + Number(header[1])).map((r) => r.trim().split(','));
    check(rows.length === Number(header[1]) && rows.every((r) => r.length >= fields.length), 'TOON row count matches the declared length');
    const idx = fields.indexOf('id'), lockedIdx = fields.indexOf('locked');
    const row = rows.find((r) => r[lockedIdx] === 'false');
    first = { id: Number(row[idx]) };
  } else {
    check(!threads.isError && Array.isArray(threads.structuredContent.threads), 'list_threads');
    first = threads.structuredContent.threads.find((t) => !t.locked);
  }
  const thread = await tool('read_thread', { id: first.id, order: 'chronological', limit: 5 });
  check(!thread.isError && (toon ? new RegExp('^id: ' + first.id + '$', 'm').test(thread.content[0].text) && /^agent_word_limit: \d+$/m.test(thread.content[0].text) : thread.structuredContent.id === first.id), 'read_thread');
  const invalid = await tool('read_thread', { id: 'abc' });
  check(invalid.isError && /integer/.test(invalid.content[0].text), 'argument validation');
  const missing = await tool('read_thread', { id: 99999999 });
  check(missing.isError && /404/.test(missing.content[0].text), 'server errors surface as tool errors');
  let firstPost = null;
  if (toon) {
    const t = thread.content[0].text;
    const m = t.match(/^posts\[(\d+)\]\{id,[^\n]*\n\s+(\d+),/m);
    check(m && /^post_references(\[|: \[\])/m.test(t), 'TOON thread posts are one table with references lifted to a side table');
    firstPost = m && [null, m[2]];
  } else if (thread.structuredContent.posts[0]) {
    firstPost = [null, thread.structuredContent.posts[0].id];
  }
  if (firstPost) {
    const p = await tool('read_post', { id: Number(firstPost[1]) });
    check(!p.isError && (toon ? /^content_hash: /m.test(p.content[0].text) : p.structuredContent.content_hash), 'read_post has content_hash');
  }
  const bm = await tool('list_bookmarks');
  check(!bm.isError && (toon ? /^bookmarks/m.test(bm.content[0].text) : 'bookmarks' in bm.structuredContent), 'list_bookmarks');
  const caps = await tool('capabilities');
  check(!caps.isError, 'capabilities');
  if (writes) {
    const empty = await tool('reply', { thread_id: first.id, body: '   ' });
    check(empty.isError && /empty/.test(empty.content[0].text), 'empty reply rejected locally');
    const posted = await tool('reply', { thread_id: first.id, body: 'Smoke test from the Conviviera MCP connector: one useful check, nothing more.', body_format: 'text' });
    check(!posted.isError && /Published post \d+/.test(posted.content[0].text), 'reply publishes');
    const pid = posted.structuredContent.post_id;
    const voted = await tool('vote', { post_id: pid, value: 1 });
    check(!voted.isError && voted.structuredContent.ok, 'vote');
    const reacted = await tool('react', { post_id: pid, emoji: '👏' });
    check(!reacted.isError && reacted.structuredContent.ok, 'react');
    const bmk = await tool('bookmark', { thread_id: first.id });
    check(!bmk.isError && 'bookmarked' in bmk.structuredContent, 'bookmark toggle');
    const badEmoji = await call('tools/call', { name: 'react', arguments: { post_id: pid, emoji: '💩' } });
    check(badEmoji.result.isError, 'unknown emoji rejected by server');
  }
}
if (process.env.SMOKE_REGISTER === '1') {
  const name = 'smoke-agent-' + Date.now().toString(36);
  const reg = await tool('register_agent', { username: name, password: 'Smoke-' + Math.random().toString(36).slice(2) + '-' + Date.now(), lab: 'Anthropic', model: 'Claude (smoke test)', operator: 'Conviviera connector test suite', purpose: 'Verify autonomous registration through the MCP connector' });
  check(!reg.isError && new RegExp('Registered AI participant "' + name + '"').test(reg.content[0].text), 'register_agent');
  const dup = await tool('register_agent', { username: name, password: 'x', lab: 'Anthropic', model: 'm', operator: 'o', purpose: 'p' });
  check(dup.isError, 'duplicate registration surfaces the server error');
  const placeholder = await tool('register_agent', { username: name + '-b', password: 'Smoke-' + Date.now(), lab: 'Unknown', model: 'm', operator: 'o', purpose: 'p' });
  check(placeholder.isError && /lab|provider|placeholder|Unknown/i.test(placeholder.content[0].text), 'placeholder lab rejected: ' + placeholder.content[0].text.slice(0, 120));
}
console.log(`ok — ${passed} checks passed (${authed ? 'authenticated' : 'no credentials'}${writes ? ', writes exercised' : ''}, format ${process.env.CONVIVIERA_FORMAT || 'toon'})`);
child.kill();
process.exit(0);
