import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createStructuredProvider } from './provider.mjs';
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
  return contextFromFacts(data, state, candidates, activeModel);
}

export function contextFromFacts(data, state, candidates, activeModel) {
  const employee = state.employee;
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
  if (context.explanationOnly && (rows.length !== context.candidates.length || rows.some((r, i) => r.event_id !== context.candidates[i].event.event_id))) throw new Error('ranking_changed');
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

export { readConfig, configurationStatus } from './provider.mjs';

export function createRecommender(options) {
  const provider = options.provider || createStructuredProvider(options);
  async function run(context) {
    const baseline = context.candidates.slice(0, 3).map(item => ({ event_id: item.event.event_id }));
    if (!context.candidates.length) return { source: 'rules', recommendations: [], message: 'В каталоге нет допустимой активности для этой цели.' };
    const result = await provider.run({ name: 'career_recommendations', prompt: context.explanationOnly ? 'Объясни уже рассчитанные рекомендации в данном порядке. Не выбирай и не переставляй активности. Используй только переданные факты; не придумывай навыки, причины пропусков или результаты. Ответ JSON по схеме.' : SYSTEM_PROMPT,
      payload: context.payload, schema: outputSchema(context), validate: answer => validateAnswer(answer, context) });
    const { value, ...metadata } = result;
    return { ...metadata, recommendations: value || baseline, promptVersion: PROMPT_VERSION,
      message: result.source === 'ai' ? 'AI сформулировал объяснения по проверенным фактам.' : result.message };
  }
  return { run, status: provider.status };
}
