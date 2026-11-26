import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonStore, parseDatabase } from '../storage.mjs';

const logger = { warn() {} };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharmacy-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pharmacy-data.json');
  return { dir, file, store: new JsonStore(file, { logger }) };
}

test('first run creates an empty database with private file permissions', async t => {
  const { file, store } = await fixture(t);
  assert.deepEqual(await store.load(), { users: {}, pharmacies: {} });
  assert.deepEqual(parseDatabase(await fs.readFile(file, 'utf8')), store.data);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('existing data survives load, save and restart', async t => {
  const { file, store } = await fixture(t);
  const data = { users: { 42: { language: 'uz', radius: 1, favorites: ['node/1'], recent: [] } }, pharmacies: { 'node/1': { name: 'A' } } };
  await fs.writeFile(file, JSON.stringify(data));
  assert.deepEqual(await store.load(), data);
  await store.save();
  assert.deepEqual(await new JsonStore(file).load(), data);
});

test('corruption without a valid backup fails safely and preserves original bytes', async t => {
  const { file, dir, store } = await fixture(t);
  await fs.writeFile(file, '{broken');
  await assert.rejects(store.load(), /Original files were preserved/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  assert.deepEqual(await fs.readdir(dir), ['pharmacy-data.json']);
});

test('valid backup recovers data and retains the corrupt original', async t => {
  const { file, dir, store } = await fixture(t);
  const good = { users: { 42: { language: 'ru' } }, pharmacies: {} };
  await fs.writeFile(file, 'damaged');
  await fs.writeFile(`${file}.bak`, JSON.stringify(good));
  assert.deepEqual(await store.load(), good);
  const corruptName = (await fs.readdir(dir)).find(name => name.includes('.corrupt-'));
  assert.ok(corruptName);
  assert.equal(await fs.readFile(path.join(dir, corruptName), 'utf8'), 'damaged');
  assert.deepEqual(parseDatabase(await fs.readFile(`${file}.bak`, 'utf8')), good);
  assert.deepEqual(await new JsonStore(file).load(), good);
});

test('missing primary is restored from backup', async t => {
  const { file, store } = await fixture(t);
  const good = { users: { 1: { radius: 5 } }, pharmacies: {} };
  await fs.writeFile(`${file}.bak`, JSON.stringify(good));
  assert.deepEqual(await store.load(), good);
  assert.deepEqual(parseDatabase(await fs.readFile(file, 'utf8')), good);
});

test('queued saves retain separate snapshots and a previous valid version', async t => {
  const { file, store } = await fixture(t);
  await store.load();
  store.data.users['1'] = { language: 'en' };
  const first = store.save();
  store.data.users['1'].language = 'uz';
  const second = store.save();
  await Promise.all([first, second]);
  assert.equal(parseDatabase(await fs.readFile(`${file}.bak`, 'utf8')).users['1'].language, 'en');
  assert.equal(parseDatabase(await fs.readFile(file, 'utf8')).users['1'].language, 'uz');
});

test('failed atomic save leaves original intact and a later save can succeed', async t => {
  const { file, store } = await fixture(t);
  await store.load();
  const atomicWrite = store.atomicWrite.bind(store);
  store.atomicWrite = async (target, text) => {
    if (target === file) throw new Error('Simulated full disk');
    return atomicWrite(target, text);
  };
  store.data.users['1'] = { language: 'ru' };
  await assert.rejects(store.save(), /full disk/);
  assert.deepEqual(parseDatabase(await fs.readFile(file, 'utf8')).users, {});
  store.atomicWrite = atomicWrite;
  await store.save();
  assert.equal(parseDatabase(await fs.readFile(file, 'utf8')).users['1'].language, 'ru');
});

test('invalid schemas never silently replace data', () => {
  for (const raw of ['null', '[]', '{}', '{"users":[],"pharmacies":{}}', '{"users":{"1":null},"pharmacies":{}}']) {
    assert.throws(() => parseDatabase(raw));
  }
});
