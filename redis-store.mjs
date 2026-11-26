import { parseDatabase } from './storage.mjs';

export class RedisStore {
  constructor(url, token, key) {
    if (!url || new URL(url).protocol !== 'https:' || !token) {
      throw new Error('Set the Upstash Redis HTTPS URL and REST token.');
    }
    this.url = url;
    this.token = token;
    this.key = key;
    this.queue = Promise.resolve();
  }

  async command(...command) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`Redis request failed (${response.status}).`);
    const { result, error } = await response.json();
    if (error) throw new Error('Redis rejected the storage command.');
    return result;
  }

  async load() {
    const raw = await this.command('GET', this.key);
    this.data = raw === null ? { users: {}, pharmacies: {} } : parseDatabase(raw);
    return this.data;
  }

  save() {
    const snapshot = JSON.stringify(this.data);
    parseDatabase(snapshot);
    this.queue = this.queue.catch(() => {}).then(async () => {
      await this.command('SET', this.key, snapshot);
    });
    return this.queue;
  }

  async flush() {
    await this.queue;
  }
}
