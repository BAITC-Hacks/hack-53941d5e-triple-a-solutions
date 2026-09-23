import { createModel } from './model.mjs';

export function planOptions(input = {}) {
  const weeklyHours = Number(input.weeklyHours ?? 4), maxSteps = Number(input.maxSteps ?? 4);
  if (!Number.isInteger(weeklyHours) || weeklyHours < 1 || weeklyHours > 20
    || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 5
    || (input.focusSkill != null && typeof input.focusSkill !== 'string')) throw new Error('Некорректные параметры плана.');
  return { weeklyHours, maxSteps, focusSkill: input.focusSkill || '' };
}

const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function buildDevelopmentPaths(data, state, input = {}) {
  const options = planOptions(input);
  if (options.focusSkill && !state.requirements.some(skill => skill.id === options.focusSkill)) throw new Error('Навык не относится к выбранной цели.');
  // Planning explores a single employee's state; it never awards actual completion or promotes their grade.
  const person = state.employee;
  const subset = { ...data, employees: [person], history: data.history.filter(row => row.employee_id === person.employee_id) };
  const modelFor = completed => {
    const model = createModel(subset, new Map([[person.employee_id, completed]]));
    if (!state.goal.assumed) model.setGoal(person.employee_id, state.goal.role, state.goal.grade);
    return model;
  };
  const score = node => {
    const gain = state.requirements.reduce((sum, skill) => sum + Math.max(0, Math.min(skill.required, node.levels[skill.id] || 0) - Math.min(skill.required, skill.level)) * (skill.id === options.focusSkill ? 8 : skill.critical ? 3 : 1), 0);
    return gain * 100 - node.hours - node.setbacks * 2;
  };
  let beam = [{ completed: [...state.simulated], steps: [], date: data.asOf, hours: 0, levels: state.levels, coverage: state.coverage, setbacks: 0 }];
  const results = [];
  for (let depth = 0; depth < options.maxSteps; depth++) {
    const expanded = [];
    for (const node of beam) {
      const model = modelFor(node.completed);
      const candidates = model.recommend(person).map(item => ({ ...item,
        start: item.event.format === 'self_paced' ? node.date : [...item.event.upcoming_sessions].sort().find(date => date >= node.date),
      })).filter(item => item.start);
      // Focus affects exploration, while prerequisites/role/grade and caps stay hard constraints.
      candidates.sort((a, b) => Number(b.impact.some(s => s.id === options.focusSkill)) - Number(a.impact.some(s => s.id === options.focusSkill)) || b.score - a.score || a.event.event_id.localeCompare(b.event.event_id));
      for (const item of candidates.slice(0, 8)) {
        const completed = [...node.completed, item.event.event_id];
        const next = modelFor(completed).snapshot(person);
        const end = addDays(item.start, Math.max(1, Math.ceil(item.event.duration_hours / options.weeklyHours * 7)));
        const prerequisites = Object.entries(item.event.prerequisites).map(([id, required]) => ({ id, name: model.skillMap.get(id)?.name || id, required, level: node.levels[id] || 0 }));
        expanded.push({ completed, date: end, hours: node.hours + item.event.duration_hours,
          levels: next.levels, coverage: next.coverage, setbacks: node.setbacks + item.setbacks,
          steps: [...node.steps, { event_id: item.event.event_id, title: item.event.title, durationHours: item.event.duration_hours,
            start: item.start, end, coverageBefore: node.coverage, coverageAfter: next.coverage, prerequisites,
            impact: item.impact.map(s => ({ id: s.id, name: s.name, before: s.level, after: s.after, required: s.required, critical: s.critical })),
            reason: `Шаг сокращает разрыв по навыкам: ${item.impact.map(s => `${s.name} ${s.level} → ${s.after}`).join('; ')}. Условия участия на этом этапе выполнены.`,
          }],
        });
      }
    }
    expanded.sort((a, b) => score(b) - score(a) || a.steps.map(s => s.event_id).join().localeCompare(b.steps.map(s => s.event_id).join()));
    beam = expanded.slice(0, 8);
    results.push(...beam);
    if (!beam.length) break;
  }
  const seen = new Set();
  return results.filter(node => !options.focusSkill || (node.levels[options.focusSkill] || 0) > (state.levels[options.focusSkill] || 0))
    .sort((a, b) => score(b) - score(a) || a.steps.length - b.steps.length)
    .filter(node => { const key = node.steps.map(s => s.event_id).join(); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 4).map((node, i) => ({
      path_id: `path-${i + 1}`, title: options.focusSkill ? `Развиваем ${state.requirements.find(s => s.id === options.focusSkill).name}` : 'Путь к карьерной цели',
      goal: state.goal, baseCompletions: [...state.simulated], options,
      coverageBefore: state.coverage, coverageAfter: node.coverage, totalHours: node.hours,
      start: data.asOf, end: node.date, steps: node.steps,
      statChanges: state.requirements.filter(s => (node.levels[s.id] || 0) > s.level)
        .map(s => ({ id: s.id, name: s.name, before: s.level, after: node.levels[s.id], required: s.required })),
      remainingGaps: state.requirements.filter(s => (node.levels[s.id] || 0) < s.required).map(s => s.name),
    }));
}

export function planProgress(plan, state) {
  if (!Array.isArray(plan?.steps) || !plan.steps.length || !Array.isArray(plan.baseCompletions)
    || JSON.stringify(plan.goal) !== JSON.stringify(state.goal)) return { valid: false, done: 0 };
  const expected = [...plan.baseCompletions, ...plan.steps.map(s => s.event_id)];
  const actual = state.simulated;
  if (actual.length < plan.baseCompletions.length || actual.some((id, i) => id !== expected[i])) return { valid: false, done: 0 };
  return { valid: true, done: actual.length - plan.baseCompletions.length };
}

export function activityContext(data, eventId) {
  const event = data.events.find(item => item.event_id === eventId && !item.mandatory);
  if (!event) throw new Error('Выберите добровольную активность из каталога.');
  const model = createModel(data);
  const audience = data.employees.filter(person => event.target_roles.includes(person.role) && event.target_grades.includes(person.grade));
  const states = audience.map(model.snapshot);
  const history = data.history.filter(row => row.event_id === eventId && row.date <= data.asOf);
  const completed = history.filter(row => row.status === 'completed').length;
  const setbacks = history.filter(row => ['no_show', 'declined', 'dropped'].includes(row.status)).length;
  const blocked = states.filter(s => Object.entries(event.prerequisites).some(([id, min]) => (s.levels[id] || 0) < min)).length;
  const needs = new Map();
  for (const state of states) for (const skill of state.gaps) needs.set(skill.id, (needs.get(skill.id) || 0) + 1);
  const skillIds = [...new Set([...event.develops_skills.map(g => g.skill_id), ...[...needs].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id)])];
  const skills = skillIds.map(id => ({ id, name: model.skillMap.get(id)?.name || id, peopleWithGap: needs.get(id) || 0, existing: event.develops_skills.some(g => g.skill_id === id) }));
  const evidence = [
    { id: 'audience', text: `В текущую аудиторию по роли и грейду входят ${audience.length} сотрудников. Предварительные требования к навыкам пока не выполнены у ${blocked}.` },
    { id: 'history', text: `История этой активности: ${history.length} записей, ${completed} завершений, ${setbacks} пропусков, отказов или прерываний. Это число записей, а не уникальных людей; причины неизвестны.` },
    { id: 'design', text: `Формат: ${event.format}; длительность: ${event.duration_hours} ч. Числовой прирост и потолки навыков заданы датасетом.` },
    ...skills.map(skill => ({ id: `skill:${skill.id}`, text: `${skill.name}: пробел относительно цели у ${skill.peopleWithGap} сотрудников целевой аудитории. ${skill.existing ? 'Навык уже есть в программе.' : 'Возможная тема дополнения, пока не включена в прирост навыков.'}` })),
  ];
  return { event, skills, evidence, stats: { audience: audience.length, blocked, records: history.length, completed, setbacks } };
}

export function baselineActivityDraft(context) {
  const { event, skills } = context;
  const skill = skills.find(s => s.existing) || skills[0];
  const name = skill?.name || 'целевой навык';
  const ids = skill ? [skill.id] : [];
  const minutes = Math.max(3, Math.round(event.duration_hours * 60));
  const first = Math.max(1, Math.floor(minutes * .2)), last = Math.max(1, Math.floor(minutes * .2));
  return {
    title: event.title,
    summary: `Черновик по правилам: дополнить активность практикой по теме «${name}» и проверить применение знаний. Эффект пока не измерен.`,
    improvements: [
      { title: 'Проверить входной уровень', action: `Дать короткую задачу на ${name} и предложить подготовительный материал тем, кому не хватает основы.`, skill_ids: ids, evidence_ids: ['audience'], success_check: 'Сравнить результат одинаковой практической задачи до и после занятия.' },
      { title: 'Добавить рабочую практику', action: `Разобрать пример из работы целевой аудитории по теме «${name}», дать самостоятельное решение и обратную связь.`, skill_ids: ids, evidence_ids: ['design'], success_check: 'Оценить решение по заранее заданной рубрике: правильность, объяснение выбора, применение.' },
      { title: 'Проверить удобство формата', action: 'Собрать добровольную обратную связь о времени, нагрузке и формате. Причины пропусков уточнить, а не угадывать.', skill_ids: ids, evidence_ids: ['history'], success_check: 'На небольшом пилоте сравнить долю завершений и качество практической работы; указать число участников.' },
    ],
    agenda: [
      { title: 'Диагностика и пример', minutes: first, exercise: `Решить вводную задачу на ${name}.`, assessment: 'Зафиксировать исходный результат.', skill_ids: ids },
      { title: 'Практический квест', minutes: minutes - first - last, exercise: `Выполнить рабочий кейс на ${name} и объяснить решение.`, assessment: 'Получить обратную связь по рубрике.', skill_ids: ids },
      { title: 'Проверка переноса в работу', minutes: last, exercise: 'Выбрать рабочую задачу, где можно применить изученное.', assessment: 'Сравнить итоговый результат с входной задачей.', skill_ids: ids },
    ],
    pilot: 'Провести добровольный пилот. До запуска определить критерии успешного решения, собрать входные и итоговые результаты, затем решить, стоит ли менять программу. Рост навыков в датасете автоматически не повышать.',
  };
}
