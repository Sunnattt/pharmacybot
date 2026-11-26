import test from 'node:test';
import assert from 'node:assert/strict';
import { createPharmacyBot, searchOverpass, distanceKm, extractPharmacy, errorMessage } from '../bot.mjs';
import { TEXT } from '../text.mjs';

const logger = { warn() {}, error() {} };
const origin = { lat: 41, lon: 69 };
const node = (id, lat = 41, lon = 69, name = `Pharmacy ${id}`) => ({ type: 'node', id, lat, lon, tags: { name } });
const response = elements => ({ ok: true, json: async () => ({ elements }) });
const user = () => ({ language: 'en', radius: 3, favorites: [], recent: [] });
const recent = (id, lat, lon = 69) => ({ id, lat, lon, radius: 3, at: 1000 });
const A = '1111111111111111', B = '2222222222222222';

function setup({ elements = [node(1)], fetchImpl, data, ...options } = {}) {
  const sends = [], answers = [], edits = [], requests = [], handlers = new Map();
  let clock = 10000;
  const store = { data: data ?? { users: {}, pharmacies: {} }, async save() {}, async flush() {} };
  const bot = {
    on(name, fn) { handlers.set(name, fn); },
    async sendMessage(chat, text, options) { sends.push({ chat, text, options }); return { message_id: sends.length }; },
    async answerCallbackQuery(id, options) { answers.push({ id, options }); },
    async editMessageReplyMarkup(markup, options) { edits.push({ markup, options }); }
  };
  const app = createPharmacyBot({ bot, store, now: () => clock, username: 'TestBot', logger,
    fetchImpl: async (...args) => { requests.push(args); return fetchImpl ? fetchImpl(...args) : response(elements); }, ...options });
  const message = (text, props = {}) => handlers.get('message')({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text, ...props });
  const location = (lat = 41, lon = 69) => message(undefined, { location: { latitude: lat, longitude: lon } });
  const callback = (action, props = {}) => handlers.get('callback_query')({ id: 'q', from: { id: 1 }, message: { chat: { id: 1, type: 'private' }, message_id: 1 }, data: action, ...props });
  return { bot, app, store, sends, answers, edits, requests, message, location, callback, advance: () => { clock += 4000; } };
}

test('start, deep links, menu and command mentions work', async () => {
  const f = setup();
  await f.message('/start referral_code');
  assert.ok(f.sends.some(s => s.options?.reply_markup?.keyboard?.[0][0].request_location));
  const count = f.sends.length;
  await f.message('/menu@OtherBot');
  assert.equal(f.sends.length, count);
  await f.message('/menu@TestBot');
  assert.equal(f.sends.length, count + 1);
});

test('all group messages and callbacks keep private history and favorites private', async () => {
  const f = setup({ data: { users: { 1: { ...user(), recent: [recent(A, 41)] } }, pharmacies: {} } });
  for (const type of ['group', 'supergroup', 'channel']) {
    await f.message('/menu', { chat: { id: -99, type } });
    for (const action of ['recent', 'favorites', `r|${A}`, 'lang:ru', 'fa|node/1']) {
      await f.callback(action, { message: { chat: { id: -99, type } } });
    }
  }
  await f.callback('recent', { inline_message_id: 'inline', message: undefined });
  await f.callback('recent', { message: { chat: { id: 2, type: 'private' } } });
  assert.equal(f.requests.length, 0);
  assert.ok(f.sends.every(s => s.text === TEXT.en.locationUnavailable));
  assert.equal(f.store.data.users['1'].language, 'en');
});

test('language changes refresh bottom keyboard and accept previous-language Menu buttons', async () => {
  const f = setup();
  for (const lang of ['uz', 'ru', 'en']) {
    await f.callback(`lang:${lang}`);
    const reply = f.sends.findLast(s => s.options?.reply_markup?.keyboard);
    assert.equal(reply.options.reply_markup.keyboard[1][0].text, TEXT[lang].menuButton);
    const count = f.sends.length;
    await f.message(TEXT.uz.menuButton);
    assert.equal(f.sends.length, count + 1);
  }
});

test('new users default to a supported Telegram language', async () => {
  const f = setup();
  await f.message('/start', { from: { id: 1, language_code: 'uz' } });
  assert.equal(f.store.data.users['1'].language, 'uz');
});

test('legacy data gets valid recent IDs without losing settings or favorites', async () => {
  const f = setup({ data: { users: { 1: { ...user(), language: 'uz', favorites: ['node/1'], recent: [{ lat: 41, lon: 69, radius: 3 }] } }, pharmacies: {} } });
  await f.message('/recent');
  assert.match(f.store.data.users['1'].recent[0].id, /^[a-f0-9]{16}$/);
  assert.deepEqual(f.store.data.users['1'].favorites, ['node/1']);
  assert.equal(f.store.data.users['1'].language, 'uz');
});

test('old recent buttons continue to search the same location after reordering', async () => {
  const f = setup({ data: { users: { 1: { ...user(), recent: [recent(A, 41), recent(B, 40)] } }, pharmacies: {} } });
  await f.callback(`r|${B}`);
  f.advance();
  await f.callback(`r|${B}`);
  assert.equal(f.requests.length, 2);
  for (const [, opts] of f.requests) assert.match(new URLSearchParams(opts.body).get('data'), /around:3000,40,69/);
  assert.equal(f.store.data.users['1'].recent.length, 2);
  assert.equal(f.store.data.users['1'].recent[0].id, B);
});

test('expired and legacy index-based buttons ask for a fresh menu', async () => {
  const f = setup();
  for (const action of ['r|0', `r|${A}`, 'r|__proto__', 'radius:9', 'bad']) await f.callback(action);
  assert.equal(f.requests.length, 0);
  assert.ok(f.sends.every(s => s.text === TEXT.en.expiredMenu));
});

test('search results are deduplicated, within radius, sorted and capped at five', async () => {
  const f = setup({ elements: [node(9, 42), node(4, 41.004), node(1, 41.001), node(2, 41.002), node(3, 41.003), node(5, 41.005), node(6, 41.006), node(1, 41.001), { type: 'node', id: 7, tags: {} }] });
  await f.location();
  const results = f.sends.at(-1);
  assert.ok(results.text.indexOf('Pharmacy 1') < results.text.indexOf('Pharmacy 4'));
  assert.equal(results.options.reply_markup.inline_keyboard.length, 6);
  assert.ok(!results.text.includes('Pharmacy 9'));
  assert.equal(Object.keys(f.store.data.pharmacies).length, 5);
  assert.equal(f.store.data.users['1'].recent.length, 1);
  for (const row of results.options.reply_markup.inline_keyboard) for (const button of row) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test('pharmacy details use original search location after another search', async () => {
  const f = setup();
  await f.location();
  const button = f.sends.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data;
  f.advance();
  await f.location(41.01, 69);
  await f.callback(button);
  assert.match(f.sends.at(-1).text, /Distance: 0 m/);
});

test('favorite add/remove buttons are idempotent and update the same message', async () => {
  const pharmacy = extractPharmacy(node(1));
  const f = setup({ data: { users: { 1: user() }, pharmacies: { 'node/1': pharmacy } } });
  await f.callback('fa|node/1');
  await f.callback('fa|node/1');
  assert.deepEqual(f.store.data.users['1'].favorites, ['node/1']);
  assert.equal(f.edits.at(-1).markup.inline_keyboard[0][0].callback_data, 'fr|node/1');
  await f.callback('fr|node/1');
  await f.callback('fr|node/1');
  assert.deepEqual(f.store.data.users['1'].favorites, []);
  await f.callback('f|node/1'); // Safely refresh a legacy toggle button.
  assert.deepEqual(f.store.data.users['1'].favorites, []);
});

test('favorites paginate instead of producing an oversized keyboard', async () => {
  const pharmacies = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`node/${i + 1}`, extractPharmacy(node(i + 1))]));
  const f = setup({ data: { users: { 1: { ...user(), favorites: Object.keys(pharmacies) } }, pharmacies } });
  await f.callback('favorites');
  assert.equal(f.sends.at(-1).options.reply_markup.inline_keyboard.length, 11);
  await f.callback('favorites|2');
  assert.equal(f.sends.at(-1).options.reply_markup.inline_keyboard.length, 4);
});

test('invalid coordinates never reach the map service', async () => {
  const f = setup();
  for (const [lat, lon] of [[NaN, 69], [91, 69], [41, -181], ['41', 69]]) await f.location(lat, lon);
  assert.equal(f.requests.length, 0);
  assert.ok(f.sends.every(s => s.text === TEXT.en.invalidLocation));
});

test('no results offers a menu to change the radius', async () => {
  const f = setup({ elements: [] });
  await f.location();
  assert.match(f.sends.at(-1).text, /No pharmacies/);
  assert.ok(f.sends.at(-1).options.reply_markup.inline_keyboard);
});

test('overlapping searches from one user are blocked', async () => {
  let finish;
  const f = setup({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.location();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.advance();
  await f.location();
  assert.equal(f.requests.length, 1);
  assert.equal(f.sends.at(-1).text, TEXT.en.rateLimit);
  finish(response([]));
  await pending;
});

test('clearing history cancels a pending search without restoring private history', async () => {
  let finish;
  const f = setup({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.location();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.message('/clearhistory');
  finish(response([node(1)]));
  await pending;
  assert.deepEqual(f.store.data.users['1'].recent, []);
  assert.equal(f.sends.at(-1).text, TEXT.en.historyCleared);
});

test('shutdown aborts pending requests, drains handlers and ignores new updates', async () => {
  let started = false;
  const f = setup({ fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    started = true;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const pending = f.location();
  while (!started) await new Promise(resolve => setImmediate(resolve));
  await f.app.close();
  await pending;
  const count = f.sends.length;
  await f.message('/menu');
  assert.equal(f.sends.length, count);
});

test('failed map servers produce a friendly error and no false empty search history', async () => {
  const f = setup({ fetchImpl: async () => { throw new Error('Offline'); } });
  await f.location();
  assert.equal(f.requests.length, 3);
  assert.equal(f.sends.at(-1).text, TEXT.en.searchError);
  assert.deepEqual(f.store.data.users['1'].recent, []);
});

test('expired callback acknowledgement does not block a valid action', async () => {
  const f = setup();
  f.bot.answerCallbackQuery = async () => { throw new Error('query is too old'); };
  await f.callback('lang:uz');
  assert.equal(f.store.data.users['1'].language, 'uz');
});

test('HTTP and partial Overpass failures retry another server', async () => {
  let count = 0;
  const elements = await searchOverpass(41, 69, 3, { logger, fetchImpl: async () => {
    count++;
    if (count === 1) return { ok: false, status: 429 };
    if (count === 2) return { ok: true, json: async () => ({ elements: [], remark: 'runtime error: timeout' }) };
    return response([node(1)]);
  } });
  assert.equal(count, 3);
  assert.equal(elements.length, 1);
});

test('pharmacies support nodes, polygon centers, localized names and full addresses', () => {
  const p = extractPharmacy({ type: 'way', id: 8, center: origin, tags: { 'addr:full': 'Full address', 'name:uz': 'Dorixona' } });
  assert.equal(p.lat, 41);
  assert.equal(p.address, 'Full address');
  assert.equal(p.tags['name:uz'], 'Dorixona');
  assert.equal(extractPharmacy({ type: 'way', id: 8, center: { lat: 100, lon: 69 } }), null);
});

test('distance handles identical and antipodal positions without NaN', () => {
  assert.equal(distanceKm(41, 69, 41, 69), 0);
  assert.ok(Math.abs(distanceKm(0, 0, 0, 180) - 20015.0868) < 0.01);
});

test('untrusted long map names stay within Telegram text and button limits', async () => {
  const f = setup({ elements: Array.from({ length: 5 }, (_, i) => node(i + 1, 41, 69, '💊'.repeat(5000))) });
  await f.location();
  assert.ok(f.sends.at(-1).text.length < 4096);
  for (const row of f.sends.at(-1).options.reply_markup.inline_keyboard) {
    for (const b of row) assert.ok(Array.from(b.text).length <= 60);
  }
});

test('all supported languages include all user messages', () => {
  const keys = Object.keys(TEXT.en).sort();
  for (const lang of ['uz', 'ru']) assert.deepEqual(Object.keys(TEXT[lang]).sort(), keys);
});

test('logs redact Telegram bot tokens', () => {
  assert.equal(errorMessage(new Error('https://api.telegram.org/bot123456789:abcdefghijklmnopqrstuvwxyz123456/sendMessage')), 'https://api.telegram.org/bot[BOT_TOKEN]/sendMessage');
});
