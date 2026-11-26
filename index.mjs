import { Bot } from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './storage.mjs';
import { createPharmacyBot, errorMessage } from './bot.mjs';
import { telegramTransport } from './telegram.mjs';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(BASE_DIR, '.env'), quiet: true });
const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const DATA_FILE = process.env.PHARMACY_DATA_FILE?.trim()
  ? path.resolve(BASE_DIR, process.env.PHARMACY_DATA_FILE.trim())
  : path.join(BASE_DIR, 'pharmacy-data.json');
let bot;
let app;
let stopping = false;
let shutdownPromise;
let pollingPromise;
const store = new JsonStore(DATA_FILE);

function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  process.exitCode = exitCode;
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  shutdownPromise = (async () => {
    try {
      const draining = app?.close();
      bot?.stop();
      await Promise.allSettled([pollingPromise, draining]);
      await bot?.close();
      await store.flush();
    } catch (error) {
      console.error(`Shutdown failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.on('unhandledRejection', error => {
  console.error(`Unexpected failure: ${errorMessage(error)}`);
  void shutdown(1);
});
process.on('uncaughtException', error => {
  console.error(`Unexpected failure: ${errorMessage(error)}`);
  void shutdown(1);
});

async function main() {
  if (!TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and enter your token.');
  // Load data and register handlers before accepting any Telegram updates.
  await store.load();
  if (stopping) return;
  bot = new Bot(TOKEN, {
    timeoutMs: 10000, maxRetries: 1, maxRetryAfterMs: 5000
  });
  bot.catch(error => {
    console.error(`Telegram update failed: ${errorMessage(error)}`);
  });
  await bot.init();
  const profile = bot.botInfo;
  if (stopping) return;
  app = createPharmacyBot({ bot: telegramTransport(bot), store, username: profile.username });
  await bot.api.setMyCommands({ commands: [
    { command: 'start', description: 'Start Pharmacy Finder' },
    { command: 'menu', description: 'Open the menu' },
    { command: 'search', description: 'Find nearby pharmacies' },
    { command: 'radius', description: 'Choose 1, 3 or 5 km' },
    { command: 'favorites', description: 'View saved pharmacies' },
    { command: 'recent', description: 'Repeat a recent search' },
    { command: 'language', description: 'English / O‘zbekcha / Русский' },
    { command: 'help', description: 'How to use the bot' },
    { command: 'privacy', description: 'How your location is used' },
    { command: 'clearhistory', description: 'Clear recent search locations' }
  ] });
  if (stopping) return;
  console.log(`💊 Pharmacy Finder @${profile.username} is ready.`);
  pollingPromise = bot.startPolling(undefined, {
    timeout: 10, allowedUpdates: ['message', 'callback_query'], maxConflictRetries: 0,
    onError: error => console.error(`Telegram polling retry: ${errorMessage(error)}`)
  });
  void pollingPromise.catch(error => {
    if (!stopping) {
      console.error(`Polling stopped: ${errorMessage(error)}`);
      if (error.errorCode === 409) console.error('Another instance or webhook is using this bot. Run only one polling instance.');
      void shutdown(1);
    }
  });
}

try {
  await main();
} catch (error) {
  console.error(`Startup failed: ${errorMessage(error)}`);
  await shutdown(1);
}
