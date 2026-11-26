import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from 'node-telegram-bot-api';
import { telegramTransport } from '../telegram.mjs';
import { createPharmacyBot } from '../bot.mjs';

const profile = { id: 123, is_bot: true, first_name: 'Test', username: 'TestBot' };
const logger = { warn() {}, error() {} };

function fixture() {
  const calls = [];
  const client = new Bot('123456:offline_dummy_token_not_for_network', {
    maxRetries: 0,
    fetch: async (url, options) => {
      const method = new URL(url).pathname.split('/').at(-1);
      const params = Object.fromEntries(new URLSearchParams(options.body));
      calls.push({ method, params });
      return Response.json({ ok: true, result: method === 'getMe' ? profile : true });
    }
  });
  const transport = telegramTransport(client, { logger });
  const store = { data: { users: {}, pharmacies: {} }, async save() {}, async flush() {} };
  const app = createPharmacyBot({ bot: transport, store, logger });
  return { client, transport, store, calls, app };
}

test('actual Telegram library dispatches messages and serializes reply keyboards', async () => {
  const f = fixture();
  await f.client.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/start' } });
  await f.app.idle();
  const sent = f.calls.filter(c => c.method === 'sendMessage');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].params.chat_id, '1');
  assert.equal(JSON.parse(sent[0].params.reply_markup).keyboard[0][0].request_location, true);
  assert.equal(f.calls.filter(c => c.method === 'getMe').length, 1);
  await f.app.close();
});

test('actual Telegram library serializes language callbacks and keyboard updates', async () => {
  const f = fixture();
  await f.client.handleUpdate({ update_id: 2, callback_query: { id: 'callback1', from: { id: 1 }, chat_instance: '1', data: 'lang:uz', message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } } });
  await f.app.idle();
  const answer = f.calls.find(c => c.method === 'answerCallbackQuery');
  assert.equal(answer.params.callback_query_id, 'callback1');
  const sent = f.calls.find(c => c.method === 'sendMessage');
  assert.equal(JSON.parse(sent.params.reply_markup).keyboard[1][0].text, '📋 Menyu');
  assert.equal(f.store.data.users['1'].language, 'uz');
  await f.app.close();
});

test('Telegram transport refreshes favorites with the current API signature', async () => {
  const f = fixture();
  await f.transport.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: 1, message_id: 2 });
  const call = f.calls.at(-1);
  assert.equal(call.method, 'editMessageReplyMarkup');
  assert.equal(call.params.message_id, '2');
  assert.deepEqual(JSON.parse(call.params.reply_markup), { inline_keyboard: [] });
});
