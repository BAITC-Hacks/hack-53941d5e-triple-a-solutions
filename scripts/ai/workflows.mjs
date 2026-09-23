import { modelFromProgress } from '../../src/prototype/state.mjs';
import { readFileSync } from 'node:fs';
import { buildContext, InputError } from './recommender.mjs';
import { buildDevelopmentPaths, planOptions, activityContext, baselineActivityDraft } from '../../src/prototype/development.mjs';

const PLAN_PROMPT = readFileSync(new URL('./plan-prompt.txt', import.meta.url), 'utf8');
const HR_PROMPT = readFileSync(new URL('./hr-prompt.txt', import.meta.url), 'utf8');
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const list = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
function checkText(value, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid_text');
}
function checkList(values, min, max) {
  if (!Array.isArray(values) || values.length < min || values.length > max) throw new Error('invalid_list');
}

export function validatePlanAnswer(answer, paths) {
  const path = paths.find(p => p.path_id === answer?.path_id);
  if (!path) throw new Error('invalid_path');
  checkText(answer.title, 160); checkText(answer.summary, 800);
  checkList(answer.steps, path.steps.length, path.steps.length);
  answer.steps.forEach((step, i) => { if (step.event_id !== path.steps[i].event_id) throw new Error('invalid_sequence'); checkText(step.reason, 600); });
  return { ...path, title: answer.title, summary: answer.summary,
    steps: path.steps.map((step, i) => ({ ...step, reason: answer.steps[i].reason })) };
}

export function validateHrAnswer(answer, ctx) {
  checkText(answer?.title, 160); checkText(answer.summary, 800); checkText(answer.pilot, 1000);
  checkList(answer.improvements, 2, 4); checkList(answer.agenda, 2, 5);
  const skillIds = new Set(ctx.skills.map(s => s.id)), factIds = new Set(ctx.evidence.map(f => f.id));
  const checkIds = (ids, allowed, min = 0) => {
    checkList(ids, min, allowed.size);
    if (new Set(ids).size !== ids.length || ids.some(id => !allowed.has(id))) throw new Error('invalid_reference');
  };
  for (const row of answer.improvements) {
    checkText(row.title, 160); checkText(row.action, 800); checkText(row.success_check, 600);
    checkIds(row.skill_ids, skillIds); checkIds(row.evidence_ids, factIds, 1);
  }
  let minutes = 0;
  for (const row of answer.agenda) {
    checkText(row.title, 160); checkText(row.exercise, 600); checkText(row.assessment, 600);
    if (!Number.isInteger(row.minutes) || row.minutes < 1) throw new Error('invalid_duration');
    minutes += row.minutes; checkIds(row.skill_ids, skillIds);
  }
  if (minutes > Math.round(ctx.event.duration_hours * 60)) throw new Error('duration_exceeds_budget');
  // Return only the supported draft fields; model output can never alter gains or actual events.
  return { title: answer.title, summary: answer.summary, pilot: answer.pilot,
    improvements: answer.improvements.map(({ title, action, skill_ids, evidence_ids, success_check }) => ({ title, action, skill_ids, evidence_ids, success_check })),
    agenda: answer.agenda.map(({ title, minutes, exercise, assessment, skill_ids }) => ({ title, minutes, exercise, assessment, skill_ids })) };
}

export function createWorkflows({ data: source, provider, preparedContext, preparedPaths }) {
  async function developmentPlan(request) {
    const data = typeof source === 'function' ? source() : source;
    const ctx = preparedContext || buildContext(data, request);
    let options, paths;
    try { options = planOptions(request.options); paths = preparedPaths ? preparedPaths(options) : buildDevelopmentPaths(data, ctx.state, options); }
    catch (error) { throw new InputError(error.message); }
    if (!paths.length) return { source: 'rules', plan: null, message: 'В каталоге не удалось построить маршрут с выбранными условиями. Попробуйте другой навык или обсудите новую активность с HR.' };
    const fallback = { ...paths[0], summary: 'Маршрут рассчитан по правилам: навыки, допуски, расписание и нагрузка проверены. Ожидаемый рост — по правилам датасета.' };
    const allowedEvents = [...new Set(paths.flatMap(path => path.steps.map(s => s.event_id)))];
    const schema = object({ path_id: { type: 'string', enum: paths.map(path => path.path_id) }, title: text(160), summary: text(800),
      steps: list(object({ event_id: { type: 'string', enum: allowedEvents }, reason: text(600) }), 1, 5) });
    const result = await provider.run({ name: 'development_plan', prompt: preparedContext ? 'Сформулируй объяснение единственного рассчитанного маршрута. Не меняй шаги, порядок, числа или навыки. Используй только факты входа. Ответ по схеме.' : PLAN_PROMPT, schema,
      payload: { employee: ctx.payload.employee, options, paths: paths.map(({ baseCompletions, ...path }) => path),
        history: ctx.payload.candidates.map(c => ({ event_id: c.event_id, evidence: c.evidence.filter(f => f.category === 'history') })) },
      validate: answer => validatePlanAnswer(answer, paths),
    });
    const { value, ...metadata } = result;
    return { ...metadata, plan: value || fallback, message: result.source === 'ai' ? 'Маршрут рассчитан кодом; AI сформулировал объяснение шагов.' : result.message };
  }

  async function improveActivity(request) {
    const data = typeof source === 'function' ? source() : source;
    if (!request || typeof request.brief !== 'string' || request.brief.length > 1200) throw new InputError('Пожелание HR должно быть текстом до 1200 символов.');
    let ctx;
    try { ctx = activityContext(data, request.eventId, modelFromProgress(data, request.progress)); } catch (error) { throw new InputError(error.message); }
    const skillItem = ctx.skills.length ? { type: 'string', enum: ctx.skills.map(s => s.id) } : { type: 'string' };
    const ids = list(skillItem, 0, ctx.skills.length);
    const schema = object({ title: text(160), summary: text(800), pilot: text(1000),
      improvements: list(object({ title: text(160), action: text(800), skill_ids: ids,
        evidence_ids: list({ type: 'string', enum: ctx.evidence.map(f => f.id) }, 1, ctx.evidence.length), success_check: text(600) }), 2, 4),
      agenda: list(object({ title: text(160), minutes: { type: 'integer', minimum: 1, maximum: Math.round(ctx.event.duration_hours * 60) },
        exercise: text(600), assessment: text(600), skill_ids: ids }), 2, 5),
    });
    const result = await provider.run({ name: 'hr_activity_draft', prompt: HR_PROMPT, schema,
      payload: { activity: ctx.event, known_skills: ctx.skills, evidence: ctx.evidence, brief: request.brief },
      validate: answer => validateHrAnswer(answer, ctx), maxTokens: 3200,
    });
    const { value, ...metadata } = result;
    return { ...metadata, eventId: ctx.event.event_id, stats: ctx.stats, evidence: ctx.evidence,
      draft: value || baselineActivityDraft(ctx),
      message: result.source === 'ai' ? 'AI подготовил предложения. Это черновик для проверки HR и пилота.' : result.message };
  }
  return { developmentPlan, improveActivity };
}
