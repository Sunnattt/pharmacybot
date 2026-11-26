import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export async function startWebhook({ bot, transport, url, secret, port }) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret ?? '')) {
    throw new Error('Set TELEGRAM_WEBHOOK_SECRET to 32–256 letters, digits, underscores or hyphens.');
  }
  const expected = Buffer.from(secret);
  const endpoint = new URL('/telegram', url);
  if (endpoint.protocol !== 'https:') throw new Error('Webhook requires HTTPS.');
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200).end('OK');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/telegram') {
      res.writeHead(404).end();
      return;
    }
    const supplied = Buffer.from(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const update = JSON.parse(Buffer.concat(chunks).toString());
      await transport.dispatch(update);
      res.writeHead(200).end();
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  try {
    await bot.api.setWebhook({
      url: endpoint.href,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 1
    });
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}
