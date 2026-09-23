import { createHash } from 'node:crypto';

export function readConfig(env = process.env) {
  const timeout = Number(env.AI_TIMEOUT_MS || 8500);
  return {
    enabled: env.AI_ENABLED !== 'false', model: env.AI_MODEL || 'gpt-4.1-mini',
    key: (env.OPENAI_API_KEY || '').trim(),
    baseUrl: (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    timeoutMs: Number.isFinite(timeout) ? Math.min(9000, Math.max(100, timeout)) : 8500,
  };
}

export function configurationStatus(config) {
  if (!config.enabled) return { ready: false, message: 'AI выключен в настройках. Доступны инструменты по правилам.' };
  if (!config.model) return { ready: false, message: 'Модель AI ещё не выбрана.' };
  let url;
  try { url = new URL(config.baseUrl); } catch { return { ready: false, message: 'Проверьте адрес AI-сервера.' }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    return { ready: false, message: 'AI-сервер должен использовать HTTPS или локальный адрес.' };
  }
  if (!local && !config.key) return { ready: false, message: 'AI ждёт подключения. Пока доступны расчёты и черновики по правилам.' };
  return { ready: true, message: 'Настройки AI готовы. Подключение проверится при первом запросе.' };
}

// One transport, timeout, cache and concurrency budget for all three workflows.
export function createStructuredProvider({ config, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map(), pending = new Map();
  const settings = () => typeof config === 'function' ? config() : config;
  async function run({ name, prompt, payload, schema, validate, maxTokens = 2400 }) {
    const current = settings();
    const status = configurationStatus(current);
    if (!status.ready) return { source: 'rules', message: status.message };
    const start = now();
    const key = createHash('sha256').update(JSON.stringify([name, prompt, payload, schema, current.model, current.baseUrl, current.key])).digest('hex');
    const hit = cache.get(key);
    if (hit && now() - hit.created < 300_000) return { ...hit.result, cached: true, elapsedMs: now() - start };
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 3) return { source: 'rules', message: 'AI занят. Показан вариант по правилам; попробуйте позже.' };
    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), current.timeoutMs);
      try {
        const response = await fetchImpl(`${current.baseUrl}/responses`, {
          method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(current.key ? { Authorization: `Bearer ${current.key}` } : {}) },
          body: JSON.stringify({ model: current.model, store: false, instructions: prompt,
            input: JSON.stringify(payload), max_output_tokens: maxTokens,
            text: { format: { type: 'json_schema', name, strict: true, schema } } }),
        });
        if (!response.ok) throw new Error(response.status === 401 ? 'key' : response.status === 429 ? 'quota' : response.status === 404 ? 'model' : 'provider');
        const body = await response.json();
        if (body.status && body.status !== 'completed') throw new Error('incomplete');
        const content = (body.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []);
        if (content.some(item => item.type === 'refusal')) throw new Error('refusal');
        const result = { source: 'ai', value: validate(JSON.parse(content.filter(item => item.type === 'output_text').map(item => item.text).join(''))),
          model: current.model, elapsedMs: now() - start, cached: false };
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { created: now(), result });
        return result;
      } catch (error) {
        const messages = { key: 'Сервис AI отклонил ключ.', quota: 'Сервис AI сообщил об ограничении запросов или квоты.', model: 'Выбранная модель недоступна для этого подключения.' };
        return { source: 'rules', elapsedMs: now() - start, message: `${controller.signal.aborted ? 'AI не успел ответить.' : messages[error.message] || 'Ответ AI недоступен или не прошёл проверку.'} Показан вариант по правилам.` };
      } finally { clearTimeout(timer); }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  return { run, status: () => configurationStatus(settings()) };
}
