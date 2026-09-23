import { createModel } from './model.mjs';
import { requestFor } from './ai-client.mjs';
import { buildDevelopmentPaths, planProgress, activityContext, baselineActivityDraft } from './development.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const sourceName = source => source === 'ai' ? 'С помощью AI' : 'По правилам · без вызова модели';
const date = value => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(value + 'T12:00:00'));
const textField = (label, name, value, max = 800) => `<label class="form-field">${escape(label)}<textarea name="${name}" maxlength="${max}" required rows="3">${escape(value)}</textarea></label>`;

async function post(path, input, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  if (!response.ok) throw new Error('unavailable');
  const result = await response.json();
  if (!['ai', 'rules'].includes(result.source)) throw new Error('invalid');
  return result;
}

// Rebuild all numerical projections from the dataset; only wording is restored from the local draft.
export function restorePlan(data, result, employee) {
  try {
    const saved = result.plan;
    if (!Array.isArray(saved.baseCompletions) || saved.baseCompletions.some(id => !data.events.some(e => e.event_id === id))
      || new Set(saved.baseCompletions).size !== saved.baseCompletions.length || !Array.isArray(saved.steps)) return null;
    const model = createModel(data, new Map([[employee.employee_id, saved.baseCompletions]]));
    if (!saved.goal.assumed && !model.setGoal(employee.employee_id, saved.goal.role, saved.goal.grade)) return null;
    const plans = buildDevelopmentPaths(data, model.snapshot(employee), saved.options);
    const plan = plans.find(p => JSON.stringify(p.steps.map(s => s.event_id)) === JSON.stringify(saved.steps.map(s => s.event_id)));
    const text = (value, fallback, max) => typeof value === 'string' && value.length <= max ? value : fallback;
    if (!plan) return null;
    return { source: result.source === 'ai' ? 'ai' : 'rules', message: 'Сохранённый план в этом браузере.',
      plan: { ...plan, title: text(saved.title, plan.title, 160), summary: text(saved.summary, '', 800),
        steps: plan.steps.map((s, i) => ({ ...s, reason: text(saved.steps[i].reason, s.reason, 600) })) } };
  } catch { return null; }
}

function usableDraft(result, context) {
  try {
    const d = result.draft;
    const isText = (v, max = 1000) => typeof v === 'string' && v.length <= max;
    return ['ai', 'rules'].includes(result.source) && isText(d.title, 160) && isText(d.summary, 800) && isText(d.pilot)
      && Array.isArray(d.improvements) && d.improvements.length >= 2 && d.improvements.length <= 4
      && d.improvements.every(r => isText(r.title, 160) && isText(r.action, 800) && isText(r.success_check, 600)
        && Array.isArray(r.evidence_ids) && r.evidence_ids.every(id => context.evidence.some(e => e.id === id)))
      && Array.isArray(d.agenda) && d.agenda.length >= 2 && d.agenda.length <= 5
      && d.agenda.every(r => isText(r.title, 160) && isText(r.exercise, 600) && isText(r.assessment, 600) && Number.isInteger(r.minutes) && r.minutes > 0)
      && d.agenda.reduce((sum, row) => sum + row.minutes, 0) <= Math.round(context.event.duration_hours * 60);
  } catch { return false; }
}

export function createWorkshop({ data, getModel, getEmployee, rerender, toast, saved, persist, eventTitle }) {
  const plans = {}, drafts = {}, settings = {}, pending = new Set(), controllers = new Set();
  let generation = 0, eventId = data.events.find(e => !e.mandatory).event_id;
  const briefs = {}, contexts = new Map();
  const context = id => {
    if (getModel().isBackend) return getModel().activityContext(id);
    if (!contexts.has(id)) contexts.set(id, activityContext(data, id));
    return contexts.get(id);
  };
  for (const employee of data.employees) {
    const result = saved.plans[employee.employee_id];
    if (result) {
      const restored = restorePlan(data, result, employee);
      if (restored) { plans[employee.employee_id] = restored; settings[employee.employee_id] = restored.plan.options; }
    }
  }
  for (const event of data.events.filter(e => !e.mandatory)) {
    if (saved.drafts[event.event_id] && usableDraft(saved.drafts[event.event_id], context(event.event_id))) drafts[event.event_id] = saved.drafts[event.event_id];
  }
  const save = () => persist({ plans, drafts });
  const employeeState = () => getModel().snapshot(getEmployee());

  function journey(state) {
    const id = state.employee.employee_id, result = plans[id], plan = result?.plan;
    const progress = planProgress(plan, state);
    const options = settings[id] || { weeklyHours: 4, maxSteps: 4, focusSkill: '' };
    const busy = pending.has(`plan:${id}`);
    return `<section class="journey panel" aria-label="Карта развития"><div class="section-head"><div><p class="eyebrow">Квест к вашей цели</p><h2>Карта развития</h2></div><span class="tag">${result ? sourceName(result.source) : 'До 5 последовательных шагов'}</span></div>
      <p class="panel-intro">Выберите навык или развивайтесь к целевой роли. Карта покажет порядок активностей и ожидаемый рост ваших «статов».</p>
      <form id="plan-form" class="planning-form"><label class="form-field">Фокус<select name="focusSkill"><option value="">Все навыки для цели</option>${state.requirements.map(s => `<option value="${escape(s.id)}" ${options.focusSkill === s.id ? 'selected' : ''}>${escape(s.name)} · ${s.level}/${s.required}</option>`).join('')}</select></label>
      <label class="form-field">Часов в неделю<input name="weeklyHours" type="number" min="1" max="20" value="${options.weeklyHours}" required></label>
      <label class="form-field">Максимум шагов<select name="maxSteps">${[1, 2, 3, 4, 5].map(n => `<option ${options.maxSteps === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="button" ${busy ? 'disabled' : ''}>${busy ? 'Строим маршрут…' : plan ? 'Перестроить план' : 'Создать план'}</button></form>
      ${result ? `<p class="workflow-status" role="status">${escape(result.message)}</p>` : '<p class="footnote">План рассчитывается по правилам. AI может только объяснить рассчитанные шаги. Перестройте карту после перезагрузки.</p>'}
      ${plan && !progress.valid ? '<div class="notice">Профиль или цель изменились. Перестройте план, чтобы получить актуальный порядок и прогноз.</div>' : ''}
      ${plan && progress.valid ? `<div class="journey-summary"><div><h3>${escape(plan.title)}</h3><p>${escape(plan.summary)}</p><small>${plan.totalHours} ч обучения · ориентир до ${date(plan.end)} · выполнено ${progress.done} из ${plan.steps.length}</small></div><div class="journey-score"><b>${plan.coverageBefore}% → ${plan.coverageAfter}%</b><span>покрытие требований после всех шагов</span></div></div>
        <div class="stat-chips">${plan.statChanges.map(s => `<span>${escape(s.name)} <b>${s.before} → ${s.after}</b></span>`).join('')}</div>
        <ol class="quest-list">${plan.steps.map((s, i) => `<li class="quest-step ${i < progress.done ? 'done' : i === progress.done ? 'next' : ''}"><span class="quest-number">${i < progress.done ? '✓' : i + 1}</span><div class="quest-body"><div class="quest-heading"><h3>${escape(eventTitle(getModel().eventMap.get(s.event_id)))}</h3><span class="tag">${i < progress.done ? 'Выполнено' : i === progress.done ? 'Следующий квест' : 'После предыдущего'}</span></div><p>${escape(s.reason)}</p><div class="course-meta">${s.durationHours} ч · ориентир ${date(s.start)} — ${date(s.end)}</div><div class="quest-gains">${s.impact.map(skill => `<span>${escape(skill.name)} <b>${skill.before} → ${skill.after}</b></span>`).join('')}</div>
        ${s.prerequisites.length ? `<small>Условия входа на этом шаге: ${s.prerequisites.map(p => `${escape(p.name)} ≥ ${p.required} (будет ${p.level})`).join('; ')}.</small>` : ''}
        ${i === progress.done ? `<button class="button secondary" data-action="quest-complete" data-event="${escape(s.event_id)}"${getModel().isBackend && !getModel().catalog().find(c => c.event.event_id === s.event_id)?.canComplete ? 'disabled' : ''}>${getModel().isBackend ? 'Отметить выполнение' : 'Завершить шаг в демо'}</button>` : ''}</div></li>`).join('')}</ol>
        ${progress.done === plan.steps.length ? '<div class="notice">Квест завершён! Посмотрите оставшиеся навыки и обсудите следующий этап с руководителем.</div>' : ''}
        <p class="footnote">${plan.remainingGaps.length ? `После маршрута останутся пробелы: ${plan.remainingGaps.map(escape).join(', ')}.` : 'По модели данных этот маршрут закрывает требования к навыкам.'} Даты — оценка нагрузки, а не запись на занятия. Проценты не означают вероятность повышения; результат обучения нужно подтвердить практикой.</p>` : ''}</section>`;
  }

  function hrPage() {
    const ctx = context(eventId), result = drafts[eventId], d = result?.draft;
    const busy = pending.has(`hr:${eventId}`);
    return `<div class="page-heading"><div><h1>Мастерская HR</h1><p class="subtitle">Превратите активность в практику, которая помогает применять навыки в работе.</p></div><span class="tag">Черновик → пилот → проверка</span></div>
      <section class="panel"><form id="hr-request-form"><label class="form-field">Какую активность дополним?<select id="activity-picker" name="eventId">${data.events.filter(e => !e.mandatory).map(e => `<option value="${e.event_id}" ${eventId === e.event_id ? 'selected' : ''}>${escape(eventTitle(e))} · ${e.duration_hours} ч</option>`).join('')}</select></label>
      <div class="hr-diagnostics"><div><b>${ctx.stats.audience}</b><span>в аудитории по роли и грейду</span></div><div><b>${ctx.stats.blocked}</b><span>пока не проходят условия входа</span></div><div><b>${ctx.stats.completed} / ${ctx.stats.records}</b><span>завершений / записей истории</span></div></div>
      <details class="evidence"><summary>На какие данные опирается помощник</summary><ul>${ctx.evidence.map(f => `<li>${escape(f.text)}</li>`).join('')}</ul></details>
      <label class="form-field">Что хочется улучшить?<textarea name="brief" rows="3" maxlength="1200" placeholder="Например: добавить практику по рабочим кейсам и понятные критерии оценки">${escape(briefs[eventId] || '')}</textarea></label>
      <button class="button" ${busy ? 'disabled' : ''}>${busy ? 'Готовим предложения…' : result ? 'Создать новый черновик' : 'Предложить улучшения'}</button><p class="footnote">Без ключа доступен шаблон по правилам. После подключения AI учтёт ваше пожелание. Повторная генерация заменит локальный черновик этой активности.</p></form></section>
      ${d ? `<section class="panel hr-draft"><div class="section-head"><h2>Предложения к программе</h2><span class="tag">${sourceName(result.source)}${result.edited ? ' · изменён HR' : ''}</span></div><p role="status">${escape(result.message)}</p>
      <form id="hr-draft-form"><label class="form-field">Название<input name="title" maxlength="160" required value="${escape(d.title)}"></label>${textField('Зачем меняем программу', 'summary', d.summary)}
      <h3>Что добавить и как проверить пользу</h3>${d.improvements.map((row, i) => `<fieldset class="draft-block"><legend>${i + 1}. ${escape(row.title)}</legend>${textField('Изменение', `action-${i}`, row.action)}${textField('Как измерить результат', `check-${i}`, row.success_check, 600)}<details class="evidence"><summary>Основание предложения</summary><ul>${row.evidence_ids.map(id => `<li>${escape(ctx.evidence.find(f => f.id === id)?.text)}</li>`).join('')}</ul></details></fieldset>`).join('')}
      <h3>Обновлённая программа · бюджет ${ctx.event.duration_hours} ч</h3>${d.agenda.map((row, i) => `<fieldset class="draft-block"><legend>${i + 1}. ${escape(row.title)}</legend><label class="form-field">Длительность, минут<input type="number" name="minutes-${i}" min="1" max="${ctx.event.duration_hours * 60}" required value="${row.minutes}"></label>${textField('Практическое задание', `exercise-${i}`, row.exercise, 600)}${textField('Обратная связь и оценка', `assessment-${i}`, row.assessment, 600)}</fieldset>`).join('')}
      ${textField('План пилота', 'pilot', d.pilot, 1000)}<p class="notice">Эффективность предложений ещё не доказана. Сначала проведите пилот. Сохранение черновика не меняет каталог и числовой прирост навыков сотрудников.</p>
      <div class="draft-actions"><button class="button" type="submit">Сохранить черновик</button><button class="button secondary" type="button" data-action="draft-download">Скачать для команды</button><span id="draft-save-status" role="status"></span></div>
      <details id="draft-export" class="evidence" hidden><summary>Текст файла для команды</summary><p>Если браузер не начал скачивание, скопируйте этот текст в файл с расширением .json.</p><label class="form-field">JSON черновика<textarea readonly rows="8" id="draft-export-text"></textarea></label></details></form></section>` : '<div class="empty"><h3>Улучшения начнутся с конкретной задачи</h3><p>Помощник предложит практику, обратную связь, критерии оценки и небольшой пилот. Все предложения можно отредактировать.</p></div>'}
      <p class="footnote">Черновики доступны до перезагрузки страницы. Для обсуждения с командой скачайте JSON. Обязательные активности не участвуют в мастерской; данные об аудитории агрегированы. Данные HR доступны после проверки прав на сервере.</p>`;
  }

  async function run(key, task) {
    if (pending.has(key)) return;
    pending.add(key);
    const version = generation, controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 11_000);
    rerender();
    try { await task(controller.signal, () => version === generation); }
    finally { clearTimeout(timer); controllers.delete(controller); if (version === generation) { pending.delete(key); rerender(); } }
  }

  function saveDraft(form) {
    const result = drafts[eventId];
    if (!result) return false;
    if (!form.reportValidity()) return false;
    const fields = new FormData(form), draft = structuredClone(result.draft);
    for (const key of ['title', 'summary', 'pilot']) draft[key] = fields.get(key).trim();
    draft.improvements.forEach((r, i) => { r.action = fields.get(`action-${i}`).trim(); r.success_check = fields.get(`check-${i}`).trim(); });
    draft.agenda.forEach((r, i) => { r.minutes = Number(fields.get(`minutes-${i}`)); r.exercise = fields.get(`exercise-${i}`).trim(); r.assessment = fields.get(`assessment-${i}`).trim(); });
    if (!usableDraft({ ...result, draft }, context(eventId))) { toast('Проверьте программу: суммарное время должно укладываться в длительность активности.'); return false; }
    result.edited ||= JSON.stringify(draft) !== JSON.stringify(result.draft);
    result.draft = draft;
    const success = save();
    document.querySelector('#draft-save-status').textContent = success ? 'Сохранено до перезагрузки страницы' : 'Не удалось сохранить в браузере — скачайте файл';
    return true;
  }

  return {
    journey, hrPage,
    reset() { generation++; controllers.forEach(c => c.abort()); controllers.clear(); pending.clear(); for (const map of [plans, drafts, settings, briefs]) for (const k of Object.keys(map)) delete map[k]; save(); },
    change(event) {
      if (event.target.id === 'activity-picker') { eventId = event.target.value; rerender(); return true; }
      if (event.target.closest('#plan-form')) { const f = new FormData(event.target.closest('form')); settings[getEmployee().employee_id] = { focusSkill: f.get('focusSkill'), weeklyHours: Number(f.get('weeklyHours')), maxSteps: Number(f.get('maxSteps')) }; }
      if (event.target.name === 'brief') briefs[eventId] = event.target.value;
      return false;
    },
    async submit(event) {
      const form = event.target;
      if (!['plan-form', 'hr-request-form', 'hr-draft-form'].includes(form.id)) return;
      event.preventDefault();
      if (form.id === 'hr-draft-form') { if (saveDraft(form)) toast('Черновик готов. Можно скачать его для команды.'); return; }
      const fields = new FormData(form);
      if (form.id === 'plan-form') {
        const state = employeeState(), input = requestFor(state), id = input.employeeId;
        const options = { weeklyHours: Number(fields.get('weeklyHours')), maxSteps: Number(fields.get('maxSteps')), focusSkill: fields.get('focusSkill') };
        settings[id] = options;
        await run(`plan:${id}`, async (signal, current) => {
          let result;
          try { result = await post('/api/development-plan', { ...input, options }, signal); }
          catch (error) {
            if (getModel().isBackend) throw new Error('Не удалось получить план с сервера. Повторите запрос.');
            const plan = buildDevelopmentPaths(data, state, options)[0] || null;
            result = { source: 'rules', plan, message: plan ? 'Сервис AI недоступен. Маршрут рассчитан по правилам в браузере.' : 'Для выбранных условий нет доступного маршрута. Попробуйте другой фокус.' };
          }
          if (!current()) return;
          const person = data.employees.find(e => e.employee_id === id);
          if (JSON.stringify(requestFor(getModel().snapshot(person))) !== JSON.stringify(input)) { toast('Профиль изменился во время расчёта. Создайте план заново.'); return; }
          plans[id] = result; save();
        });
      } else {
        const id = eventId, brief = String(fields.get('brief'));
        briefs[id] = brief;
        await run(`hr:${id}`, async (signal, current) => {
          let result;
          try { result = await post('/api/hr/improve-activity', { eventId: id, brief }, signal); }
          catch { if (getModel().isBackend) throw new Error('Не удалось получить HR-черновик с сервера.'); result = { source: 'rules', eventId: id, draft: baselineActivityDraft(context(id)), message: 'Сервис AI недоступен. Показан черновик по правилам.' }; }
          if (current() && usableDraft(result, context(id))) { drafts[id] = result; save(); }
        });
      }
    },
    async action(name, button) {
      if (name === 'quest-complete') {
        const state = employeeState(), plan = plans[state.employee.employee_id]?.plan, progress = planProgress(plan, state);
        if (progress.valid && plan.steps[progress.done]?.event_id === button.dataset.event && await getModel().complete(state.employee.employee_id, button.dataset.event)) {
          save(); rerender(); toast(getModel().isBackend ? 'Выполнение сохранено. Шаг программы завершится после всех сессий.' : 'Квест завершён в демо. Следующий шаг открыт.');
        }
        return true;
      }
      if (name === 'draft-download') {
        if (!saveDraft(document.querySelector('#hr-draft-form'))) return true;
        const output = { kind: 'career-quest-activity-proposal', version: 1, eventId, exportedAt: new Date().toISOString(), ...drafts[eventId] };
        const json = JSON.stringify(output, null, 2);
        document.querySelector('#draft-export-text').value = json;
        document.querySelector('#draft-export').hidden = false;
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `career-quest-${eventId}-proposal.json`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
      }
      return false;
    },
  };
}
