import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseDatabase(raw) {
  const data = JSON.parse(raw);
  if (!isRecord(data) || !isRecord(data.users) || !isRecord(data.pharmacies)) {
    throw new Error('Database must contain users and pharmacies objects.');
  }
  if (Object.values(data.users).some(user => !isRecord(user)) ||
      Object.values(data.pharmacies).some(pharmacy => !isRecord(pharmacy))) {
    throw new Error('Database contains invalid records.');
  }
  return data;
}

// One process owns this store. Every save takes its own snapshot, then writes
// atomically. A previous valid version remains available as .bak.
export class JsonStore {
  constructor(file, { logger = console } = {}) {
    this.file = file;
    this.backupFile = `${file}.bak`;
    this.logger = logger;
    this.data = null;
    this.queue = Promise.resolve();
    this.primaryIsValid = false;
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let primaryError;
    try {
      this.data = parseDatabase(await fs.readFile(this.file, 'utf8'));
      this.primaryIsValid = true;
      return this.data;
    } catch (error) {
      primaryError = error;
      // A permission or I/O problem must never be treated as an empty database.
      if (error.code && error.code !== 'ENOENT') throw error;
    }

    try {
      this.data = parseDatabase(await fs.readFile(this.backupFile, 'utf8'));
    } catch (backupError) {
      if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT') {
        this.data = { users: {}, pharmacies: {} };
        await this.save();
        return this.data;
      }
      throw new Error('Cannot safely load the database or its backup. Original files were preserved.', {
        cause: primaryError
      });
    }

    if (primaryError.code !== 'ENOENT') {
      const corruptFile = `${this.file}.corrupt-${Date.now()}-${randomUUID()}`;
      await fs.copyFile(this.file, corruptFile);
      await fs.chmod(corruptFile, 0o600);
    }
    this.logger.warn('Recovered pharmacy data from its backup.');
    await this.save();
    return this.data;
  }

  async atomicWrite(file, contents) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') this.logger.warn('Could not clean up a temporary database file.');
      });
    }
  }

  save() {
    if (!this.data) return Promise.reject(new Error('Load the database before saving.'));
    let snapshot;
    try {
      snapshot = JSON.stringify(this.data, null, 2);
      parseDatabase(snapshot);
    } catch (error) {
      return Promise.reject(error);
    }
    const next = this.queue.catch(() => {}).then(async () => {
      if (this.primaryIsValid) {
        const previous = await fs.readFile(this.file, 'utf8');
        parseDatabase(previous);
        await this.atomicWrite(this.backupFile, previous);
      }
      await this.atomicWrite(this.file, snapshot);
      this.primaryIsValid = true;
    });
    this.queue = next;
    return next;
  }

  async flush() {
    await this.queue;
  }
}
