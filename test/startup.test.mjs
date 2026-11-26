import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));

test('missing token exits clearly without touching the database', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharmacy-start-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['index.mjs'], {
    cwd: appDir, env: { ...process.env, TELEGRAM_BOT_TOKEN: '', PHARMACY_DATA_FILE: path.join(dir, 'data.json') }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /Missing TELEGRAM_BOT_TOKEN/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('real startup, polling, search, data saving and SIGTERM work together offline', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharmacy-runtime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  const dataFile = path.join(dir, 'data.json');
  // Every outbound request is intercepted before the application is imported.
  const preload = `
    import { appendFileSync } from 'node:fs';
    let delivered = false;
    globalThis.fetch = async (url, options = {}) => {
      const host = new URL(url).hostname;
      if (host !== 'api.telegram.org') return Response.json({ elements: [{type:'node',id:1,lat:41,lon:69,tags:{name:'Offline Pharmacy'}}] });
      const method = new URL(url).pathname.split('/').at(-1);
      const params = Object.fromEntries(new URLSearchParams(options.body));
      appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify({method,params})+'\\n');
      let result = true;
      if (method === 'getMe') result = {id:123,is_bot:true,first_name:'Test',username:'OfflineBot'};
      if (method === 'getUpdates') {
        if (delivered) return new Promise((resolve,reject) => {
          if (options.signal?.aborted) reject(options.signal.reason);
          else options.signal?.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
        });
        delivered = true;
        result = [
          {update_id:1,message:{message_id:1,date:0,from:{id:1},chat:{id:1,type:'private'},text:'/start'}},
          {update_id:2,callback_query:{id:'q1',from:{id:1},chat_instance:'1',data:'lang:uz',message:{message_id:1,date:0,chat:{id:1,type:'private'}}}},
          {update_id:3,message:{message_id:2,date:0,from:{id:1},chat:{id:1,type:'private'},location:{latitude:41,longitude:69}}},
          {update_id:4,callback_query:{id:'group',from:{id:1},chat_instance:'-99',data:'recent',message:{message_id:1,date:0,chat:{id:-99,type:'group'}}}}
        ];
      }
      return Response.json({ok:true,result});
    };
  `;
  const child = spawn(process.execPath, ['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`, 'index.mjs'], {
    cwd: appDir, env: { ...process.env, TELEGRAM_BOT_TOKEN: '123456:offline_token_not_for_network', PHARMACY_DATA_FILE: dataFile, TEST_CALL_LOG: log }
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.resume();
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let calls;
  for (let i = 0; i < 150; i++) {
    calls = (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (calls.some(c => c.method === 'sendMessage' && c.params.text?.includes('Offline Pharmacy'))) break;
    if (child.exitCode !== null) assert.fail(`Startup exited unexpectedly: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(calls.some(c => c.method === 'sendMessage' && c.params.text?.includes('Offline Pharmacy')), stderr);
  child.kill('SIGTERM');
  const result = await exited;
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  const saved = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(saved.users['1'].language, 'uz');
  assert.equal(saved.users['1'].recent.length, 1);
  assert.ok(saved.pharmacies['node/1']);
  assert.ok(!calls.some(c => c.method === 'sendMessage' && c.params.chat_id === '-99'));
  const registration = calls.find(c => c.method === 'setMyCommands');
  assert.ok(JSON.parse(registration.params.commands).some(c => c.command === 'clearhistory'));
});
