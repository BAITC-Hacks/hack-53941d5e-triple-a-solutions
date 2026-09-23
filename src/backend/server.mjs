import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, ApiError, fail, fingerprint } from './store.mjs';
import { CareerService } from './service.mjs';
import { createImports } from './imports.mjs';
import { workflowService } from './workflows.mjs';
import { createStructuredProvider, readConfig } from '../../scripts/ai/provider.mjs';
import { readJson, loadDataset, validateDataset } from './validate.mjs';
import { createModel } from '../prototype/model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicFiles = new Map([
  ...['ai-client.mjs', 'development.mjs', 'workshop-ui.mjs', 'import-ui.mjs'].map(file => ['/' + file, [file, 'text/javascript']]),
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']], ['/model.mjs', ['model.mjs', 'text/javascript']],
  ['/api-client.mjs', ['api-client.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
]);
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'JSON_REQUIRED', 'Ожидается application/json');
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 10 * 1024 * 1024) fail(413, 'BODY_TOO_LARGE', 'Максимальный размер запроса — 10 МБ'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { fail(400, 'INVALID_JSON', 'Некорректный JSON-объект'); }
}
function fields(value, allowed) { if (Object.keys(value).some(k => !allowed.includes(k))) fail(422, 'UNKNOWN_FIELD', 'В запросе есть неподдерживаемые поля'); }

export function buildServer({ dbPath = ':memory:', dataset, rules, asOf, employeeId = 'E0066', employeeToken, hrToken, aiProvider = createStructuredProvider({ config: readConfig(process.env) }) } = {}) {
  if (!employeeToken || !hrToken || employeeToken === hrToken) throw new Error('Distinct employee and HR tokens required');
  const store = new Store(dbPath, dataset, rules);
  let service = new CareerService(store, asOf);
  if (!service.originalEmployees.has(employeeId)) throw new Error('Configured employee does not exist');
  const imports = createImports(store, () => service, value => { service = value; }, employeeId);
  const sessions = new Map();
  const loginAttempts = new Map();
  const send = (res, status, result) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); };
  const account = token => equal(token, hrToken) ? { role: 'hr', employeeId } : equal(token, employeeToken) ? { role: 'employee', employeeId } : null;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${req.headers.host}`).hostname)) fail(403, 'HOST_FORBIDDEN', 'Недопустимый адрес сервера');
      if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) fail(403, 'ORIGIN_FORBIDDEN', 'Запрос с другого сайта запрещён');
      if (path === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, mode: 'backend' });
      if (!path.startsWith('/api/')) {
        const file = publicFiles.get(path);
        if (req.method !== 'GET' || !file) fail(404, 'NOT_FOUND', 'Ресурс не найден');
        res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
        return res.end(readFileSync(resolve(ROOT, 'src/prototype', file[0])));
      }
      if (path === '/api/auth/session' && req.method === 'POST') {
        const address = req.socket.remoteAddress;
        const attempt = loginAttempts.get(address) || { count: 0, until: Date.now() + 60000 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 60000; }
        if (++attempt.count > 20) fail(429, 'TOO_MANY_ATTEMPTS', 'Повторите вход через минуту');
        loginAttempts.set(address, attempt);
        const input = await body(req); fields(input, ['token']); const user = account(input.token);
        if (!user) fail(401, 'UNAUTHORIZED', 'Неверный ключ доступа');
        const sid = randomBytes(32).toString('hex');
        for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
        sessions.set(sid, { ...user, expires: Date.now() + 8 * 3600000 });
        res.setHeader('Set-Cookie', `cq_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return send(res, 200, user);
      }
      const sid = /(?:^|;\s*)cq_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = sessions.get(sid);
      const bearer = req.headers.authorization?.startsWith('Bearer ') ? account(req.headers.authorization.slice(7)) : null;
      const user = bearer || (session?.expires > Date.now() ? session : null);
      if (!user) fail(401, 'UNAUTHORIZED', 'Войдите с ключом доступа');
      if (path === '/api/auth/session' && req.method === 'DELETE') {
        sessions.delete(sid); res.setHeader('Set-Cookie', 'cq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(res, 200, { ok: true });
      }
      if (path.startsWith('/api/hr/') || path.startsWith('/api/dataset') || path.startsWith('/api/import/')) if (user.role !== 'hr') fail(403, 'HR_REQUIRED', 'Доступно только HR');
      if (path === '/api/bootstrap' && req.method === 'GET') {
        const profile = service.profile(user.employeeId);
        return send(res, 200, { asOf: service.asOf, user: { role: user.role, employeeId: user.employeeId }, employees: [profile.employee],
          skills: service.data.skills, roleProfiles: service.data.roleProfiles, events: service.data.events, demoRules: service.rules, policyVersion: store.version });
      }
      if (path === '/api/ai/status' && req.method === 'GET') return send(res, 200, aiProvider.status());
      if (path === '/api/hr/activity-contexts' && req.method === 'GET') return send(res, 200, workflowService(service, aiProvider).contexts());
      if (['/api/recommendations', '/api/development-plan', '/api/hr/improve-activity'].includes(path) && req.method === 'POST') {
        const input = await body(req), workflows = workflowService(service, aiProvider);
        if (input.datasetVersion && input.datasetVersion !== store.version) fail(409, 'STALE_DATASET', 'Набор данных изменился. Обновите страницу.');
        if (path === '/api/hr/improve-activity') {
          fields(input, ['eventId', 'brief', 'datasetVersion']);
          return send(res, 200, await workflows.improveActivity(input));
        }
        fields(input, ['employeeId', 'revision', 'datasetVersion', ...(path === '/api/development-plan' ? ['options'] : [])]);
        if (input.employeeId !== user.employeeId) fail(403, 'PROFILE_FORBIDDEN', 'Чужие профили доступны только через HR-функции');
        return send(res, 200, await (path === '/api/recommendations' ? workflows.recommendations(user.employeeId) : workflows.developmentPlan(user.employeeId, input.options)));
      }
      if (path === '/api/hr/overview' && req.method === 'GET') return send(res, 200, service.overview());
      const hrProfile = /^\/api\/hr\/employees\/([A-Za-z0-9_-]+)$/.exec(path);
      if (hrProfile && req.method === 'GET') return send(res, 200, service.profile(hrProfile[1]));
      if (['/api/dataset/validate', '/api/dataset/import'].includes(path) && req.method === 'POST') {
        const input = await body(req); fields(input, ['dataset', 'rules']);
        const incomingRules = input.rules || store.rules;
        const validation = validateDataset(input.dataset, incomingRules);
        if (!validation.valid) fail(422, 'INVALID_DATASET', 'Датасет не прошёл проверку', validation.errors);
        if (path.endsWith('/validate')) return send(res, 200, { valid: true, counts: validation.counts });
        return send(res, 200, imports.replace(validation.data, incomingRules));
      }
      if (path === '/api/dataset' && req.method === 'GET') return send(res, 200, imports.snapshot());
      const importing = /^\/api\/import\/(preview|commit|undo)$/.exec(path);
      if (importing && req.method === 'POST') {
        const input = await body(req);
        fields(input, importing[1] === 'preview' ? ['version', 'files', 'replace'] : ['version', 'token']);
        return send(res, 200, imports[importing[1]](input));
      }
      const route = /^\/api\/employees\/([A-Za-z0-9_-]+)(?:\/(goal|recommendations|events)(?:\/([A-Za-z0-9_-]+)\/(complete))?)?$/.exec(path);
      if (!route) fail(404, 'NOT_FOUND', 'Маршрут не найден');
      const [, id, resource, eventId, action] = route;
      if (id !== user.employeeId) fail(403, 'PROFILE_FORBIDDEN', 'Чужие профили доступны только через HR-функции');
      if (!resource && req.method === 'GET') return send(res, 200, service.profile(id));
      if (resource === 'recommendations' && req.method === 'GET') return send(res, 200, service.recommendations(id));
      if (resource === 'events' && !eventId && req.method === 'GET') return send(res, 200, { events: service.catalog(id), asOf: service.asOf });
      if (resource === 'goal' && req.method === 'PUT') { const input = await body(req); fields(input, ['role', 'grade']); return send(res, 200, service.setGoal(id, input)); }
      if (resource === 'events' && action === 'complete' && req.method === 'POST') {
        const input = await body(req); fields(input, ['session_id']);
        return send(res, 200, service.complete(id, eventId, input.session_id, req.headers['idempotency-key']));
      }
      fail(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Request failed:', error.message);
      if (!res.headersSent) send(res, error.status || (error.constructor.name === 'InputError' ? 400 : 500), { error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : 'Внутренняя ошибка сервера', details: error.details } });
      else res.end();
    }
  });
  return { server, store, get service() { return service; } };
}

export function startBackend() {
  const local = resolve(ROOT, '.local'); mkdirSync(local, { recursive: true });
  const accessPath = resolve(local, 'access.json');
  if (!existsSync(accessPath)) writeFileSync(accessPath, JSON.stringify({ employeeToken: randomBytes(32).toString('hex'), hrToken: randomBytes(32).toString('hex') }, null, 2), { mode: 0o600 });
  const access = readJson(accessPath);
  const dbPath = resolve(process.env.CQ_DB_PATH || resolve(local, 'career-quest.sqlite'));
  mkdirSync(dirname(dbPath), { recursive: true });
  const app = buildServer({ dbPath, dataset: loadDataset(process.env.CQ_DATASET || resolve(ROOT, 'src/prototype/data.json')),
    rules: readJson(resolve(ROOT, 'src/prototype/demo-rules.json')), asOf: process.env.CQ_AS_OF,
    employeeId: process.env.CQ_EMPLOYEE_ID || 'E0066', employeeToken: process.env.CQ_EMPLOYEE_TOKEN || access.employeeToken, hrToken: process.env.CQ_HR_TOKEN || access.hrToken });
  const port = Number(process.env.PORT || 4173);
  app.server.listen(port, '127.0.0.1', () => console.log(`Career Quest: http://127.0.0.1:${port}\nКлючи входа: ${accessPath}\nМодельная дата: ${app.service.asOf}`));
  const stop = () => app.server.close(() => { app.store.close(); process.exit(0); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startBackend();
