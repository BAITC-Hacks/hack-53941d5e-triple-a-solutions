import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createModel } from '../../src/prototype/model.mjs';

export const SYSTEM_PROMPT = readFileSync(new URL('./system-prompt.txt', import.meta.url), 'utf8');
export const PROMPT_VERSION = createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 12);

export class InputError extends Error {}

export function buildContext(data, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new InputError('Некорректный запрос.');
  const employee = data.employees.find(row => row.employee_id === request.employeeId);
  if (!employee) throw new InputError('Сотрудник не найден.');
  const model = createModel(data);
  if (request.goal && !model.setGoal(employee.employee_id, request.goal.role, request.goal.grade)) {
    throw new InputError('Неизвестная карьерная цель.');
  }
  const simulated = request.simulated ?? [];
  if (!Array.isArray(simulated) || simulated.length > data.events.length || new Set(simulated).size !== simulated.length) {
    throw new InputError('Некорректный список завершений.');
  }
  // Replay completion gains without depending on the current goal: goals may change after completion.
  const before = model.snapshot(employee);
  const levels = { ...before.levels };
  for (const id of simulated) {
    const event = model.eventMap.get(id);
    if (!event || event.mandatory || !event.target_roles.includes(employee.role)
      || !event.target_grades.includes(employee.grade) || (before.done.has(id) && id !== 'EV_036')
      || Object.entries(event.prerequisites).some(([skill, min]) => (levels[skill] || 0) < min)
      || (event.format !== 'self_paced' && !event.upcoming_sessions.some(date => date >= data.asOf))) {
      throw new InputError('Недопустимое завершение активности.');
    }
    for (const gain of event.develops_skills) {
      levels[gain.skill_id] = Math.max(levels[gain.skill_id] || 0,
        Math.min((levels[gain.skill_id] || 0) + gain.gain, gain.max_level, 5));
    }
  }
  // Same in-memory semantics as the browser, including a goal changed after completion.
  const activeModel = createModel(data, new Map([[employee.employee_id, simulated]]));
  if (request.goal) activeModel.setGoal(employee.employee_id, request.goal.role, request.goal.grade);
  const state = activeModel.snapshot(employee);
  const candidates = activeModel.recommend(employee).filter(item => !simulated.includes(item.event.event_id));
  const facts = new Map();
  const add = (id, category, text) => {
    const fact = { id, category, text };
    facts.set(id, fact);
    return fact;
  };
  const publicCandidates = candidates.map(item => {
    const { event } = item;
    const prefix = event.event_id;
    const evidence = [
      add(`${prefix}:goal`, 'goal', `Текущая роль: ${employee.role}, ${employee.grade}. Цель: ${state.goal.role}, ${state.goal.grade}${state.goal.assumed ? ' (предполагаемая)' : ''}.`),
      ...item.impact.map(skill => add(`${prefix}:skill:${skill.id}`, 'skill', `${skill.name}: ${skill.level} → ${skill.after}; требуется ${skill.required}. ${skill.critical ? 'Критичный навык.' : 'Навык для цели.'}`)),
      add(`${prefix}:history`, 'history', `Активности такого типа и формата: завершено ${item.successes}; пропущено, отклонено или прервано ${item.setbacks}. ${item.ongoing ? 'Эта активность уже начата.' : 'Эта активность сейчас не отмечена как начатая.'}`),
      add(`${prefix}:eligibility`, 'eligibility', `Допуск по текущей роли, грейду и навыкам проверен. Формат: ${event.format}; длительность: ${event.duration_hours} ч.`),
    ];
    return {
      event_id: prefix, title: event.title, type: event.type, format: event.format,
      duration_hours: event.duration_hours, next_session: item.session || null,
      ongoing: item.ongoing,
      impact: item.impact.map(s => ({ skill_id: s.id, name: s.name, level: s.level, after: s.after, required: s.required, critical: s.critical })),
      evidence,
    };
  }).sort((a, b) => a.event_id.localeCompare(b.event_id));
  return {
    model: activeModel, state, candidates, facts,
    payload: {
      as_of: data.asOf, language: 'ru',
      employee: { role: employee.role, grade: employee.grade, goal: state.goal },
      candidates: publicCandidates,
    },
  };
}

export function outputSchema(context) {
  return {
    type: 'object', additionalProperties: false,
    properties: { recommendations: {
      type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'object', additionalProperties: false,
        properties: {
          event_id: { type: 'string', enum: context.candidates.map(item => item.event.event_id) },
          reason: { type: 'string', minLength: 1, maxLength: 800 },
          evidence_ids: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'string', enum: [...context.facts.keys()] } },
        }, required: ['event_id', 'reason', 'evidence_ids'],
      },
    } }, required: ['recommendations'],
  };
}

export function validateAnswer(answer, context) {
  const rows = answer?.recommendations;
  if (!Array.isArray(rows) || !rows.length || rows.length > 3) throw new Error('invalid_output');
  const used = new Set();
  return rows.map(row => {
    if (!row || used.has(row.event_id) || !context.candidates.some(item => item.event.event_id === row.event_id)
      || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 800
      || !Array.isArray(row.evidence_ids) || row.evidence_ids.length < 3 || row.evidence_ids.length > 12
      || new Set(row.evidence_ids).size !== row.evidence_ids.length) throw new Error('invalid_output');
    used.add(row.event_id);
    const evidence = row.evidence_ids.map(id => {
      const fact = context.facts.get(id);
      if (!fact || !id.startsWith(`${row.event_id}:`)) throw new Error('invalid_evidence');
      return fact;
    });
    if (!['goal', 'skill', 'history'].every(category => evidence.some(fact => fact.category === category))) {
      throw new Error('missing_factors');
    }
    return { event_id: row.event_id, reason: row.reason.trim(), evidence };
  });
}

export function readConfig(env = process.env) {
  const timeout = Number(env.AI_TIMEOUT_MS || 8000);
  return {
    enabled: env.AI_ENABLED === 'true', model: env.AI_MODEL || '', key: env.OPENAI_API_KEY || '',
    baseUrl: (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    dataApproved: env.AI_DATA_APPROVED === 'true',
    timeoutMs: Number.isFinite(timeout) ? Math.min(9000, Math.max(100, timeout)) : 8000,
  };
}

export function configurationStatus(config) {
  if (!config.enabled) return { ready: false, message: 'AI пока не подключён. Доступен подбор по правилам.' };
  if (!config.dataApproved) return { ready: false, message: 'Для AI нужно подтвердить разрешённое использование данных в настройках сервера.' };
  if (!config.model) return { ready: false, message: 'Модель AI ещё не выбрана в настройках сервера.' };
  let url;
  try { url = new URL(config.baseUrl); } catch { return { ready: false, message: 'Проверьте адрес AI-сервера.' }; }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    return { ready: false, message: 'AI-сервер должен использовать HTTPS или локальный адрес.' };
  }
  if (url.hostname === 'api.openai.com' && !config.key) return { ready: false, message: 'На сервере не задан ключ OpenAI API.' };
  return { ready: true, message: 'AI готов подобрать шаги с учётом цели и истории.' };
}

export function createRecommender({ config, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map();
  const pending = new Map();
  const baseline = context => context.candidates.slice(0, 3).map(item => ({ event_id: item.event.event_id }));
  async function run(context) {
    const start = now();
    const fallback = message => ({ source: 'rules', message, recommendations: baseline(context), elapsedMs: now() - start });
    if (!context.candidates.length) return fallback('В каталоге нет допустимой активности для этой цели.');
    const status = configurationStatus(config);
    if (!status.ready) return fallback(status.message);
    const cacheKey = createHash('sha256').update(JSON.stringify([PROMPT_VERSION, config.model, config.baseUrl, context.payload])).digest('hex');
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.created < 300_000) return { ...hit.result, cached: true, elapsedMs: now() - start };
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    if (pending.size >= 3) return fallback('AI занят. Пока показан подбор по правилам; попробуйте позже.');
    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(`${config.baseUrl}/responses`, {
          method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
          body: JSON.stringify({
            model: config.model, store: false, instructions: SYSTEM_PROMPT,
            input: JSON.stringify(context.payload), max_output_tokens: 1600,
            text: { format: { type: 'json_schema', name: 'career_recommendations', strict: true, schema: outputSchema(context) } },
          }),
        });
        if (!response.ok) throw new Error('provider_error');
        const body = await response.json();
        if (body.status && body.status !== 'completed') throw new Error('incomplete_output');
        const content = (body.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []);
        if (content.some(item => item.type === 'refusal')) throw new Error('refusal');
        const text = content.filter(item => item.type === 'output_text').map(item => item.text).join('');
        const recommendations = validateAnswer(JSON.parse(text), context);
        const result = { source: 'ai', recommendations, model: config.model, promptVersion: PROMPT_VERSION,
          elapsedMs: now() - start, cached: false, message: 'AI выбрал следующие шаги. Условия участия и ссылки на факты проверены приложением.' };
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { created: now(), result });
        return result;
      } catch {
        return fallback(controller.signal.aborted
          ? 'AI не успел ответить. Показан подбор по правилам; можно повторить запрос.'
          : 'Ответ AI недоступен или не прошёл проверку. Показан подбор по правилам.');
      } finally { clearTimeout(timer); }
    })();
    pending.set(cacheKey, task);
    try { return await task; } finally { pending.delete(cacheKey); }
  }
  return { run, status: () => configurationStatus(config) };
}
