import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildContext, createRecommender, readConfig, InputError } from './ai/recommender.mjs';
import { createStructuredProvider } from './ai/provider.mjs';
import { createWorkflows } from './ai/workflows.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function readLocalEnv(file = resolve(ROOT, '.env.local')) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
export function loadLocalEnv(file) {
  for (const [key, value] of Object.entries(readLocalEnv(file))) if (process.env[key] === undefined) process.env[key] = value;
}
export function configReader(file = resolve(ROOT, '.env.local'), env = process.env) {
  // Read on each request: adding the key is enough; no restart or source edit is needed.
  return () => readConfig({ ...readLocalEnv(file), ...env });
}

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']], ['/model.mjs', ['model.mjs', 'text/javascript']],
  ['/ai-client.mjs', ['ai-client.mjs', 'text/javascript']],
  ['/development.mjs', ['development.mjs', 'text/javascript']],
  ['/workshop-ui.mjs', ['workshop-ui.mjs', 'text/javascript']],
  ['/local-progress.mjs', ['local-progress.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']], ['/data.json', ['data.json', 'application/json']],
]);

export function createAppServer({ data, recommender, workflows, staticRoot = resolve(ROOT, 'src/prototype') }) {
  return createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    const authority = `127.0.0.1:${req.socket.localPort}`;
    const localhost = `localhost:${req.socket.localPort}`;
    if (![authority, localhost].includes(req.headers.host)) return send(403, { error: 'Недопустимый адрес.' });
    if (req.headers.origin && ![`http://${authority}`, `http://${localhost}`].includes(req.headers.origin)) return send(403, { error: 'Недопустимый источник запроса.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Недопустимый источник запроса.' });
    const url = new URL(req.url, `http://${authority}`);
    if (req.method === 'GET' && url.pathname === '/api/ai/status') return send(200, recommender.status());
    if (req.method === 'POST' && ['/api/recommendations', '/api/development-plan', '/api/hr/improve-activity'].includes(url.pathname)) {
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Ожидается JSON.' });
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16_384) { send(413, { error: 'Слишком большой запрос.' }); return; }
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname !== '/api/recommendations' && !workflows) return send(503, { error: 'Сервис пока не доступен.' });
        if (url.pathname === '/api/development-plan') return send(200, await workflows.developmentPlan(input));
        if (url.pathname === '/api/hr/improve-activity') return send(200, await workflows.improveActivity(input));
        const context = buildContext(data, input);
        return send(200, await recommender.run(context));
      } catch (error) {
        return send(error instanceof InputError || error instanceof SyntaxError ? 400 : 500,
          { error: error instanceof InputError ? error.message : 'Не удалось обработать запрос.' });
      }
    }
    if (req.method !== 'GET') return send(405, { error: 'Метод не поддерживается.' });
    const asset = assets.get(url.pathname);
    if (!asset) return send(404, { error: 'Страница не найдена.' });
    try {
      const bytes = readFileSync(resolve(staticRoot, asset[0]));
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(bytes);
    } catch { send(404, { error: 'Файл не найден.' }); }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  loadLocalEnv();
  const index = process.argv.indexOf('--port');
  if (index >= 0) process.env.PORT = process.argv[index + 1];
  const { startBackend } = await import('../src/backend/server.mjs');
  startBackend();
}
