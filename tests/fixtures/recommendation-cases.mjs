// Small invented cases, independent of organizer profiles. Expected choices are our product hypotheses,
// not jury labels or evidence that a recommendation improves real career outcomes.
const skills = [
  { skill_id: 'DESIGN', name: 'System Design' }, { skill_id: 'SPEAK', name: 'Public Speaking' },
  { skill_id: 'SQL', name: 'SQL' },
];
const event = (id, changes = {}) => ({
  event_id: id, title: id, mandatory: false, type: 'course', format: 'self_paced', duration_hours: 4,
  target_roles: ['Backend Engineer'], target_grades: ['Middle'], prerequisites: {}, upcoming_sessions: [],
  develops_skills: [{ skill_id: 'DESIGN', gain: 1, max_level: 4 }], ...changes,
});
const employee = changes => ({ employee_id: 'SYNTHETIC', full_name: 'Synthetic Example', role: 'Backend Engineer', grade: 'Middle',
  last_review_date: '2026-09-01', skills: { DESIGN: 2, SPEAK: 1, SQL: 1 },
  career_goal: { target_role: 'Backend Engineer', target_grade: 'Senior' }, ...changes });
const dataset = (events, { person = {}, history = [] } = {}) => ({
  asOf: '2026-10-01', employees: [employee(person)], events, skills,
  roleProfiles: [
    { role: 'Backend Engineer', grade: 'Senior', required_skills: { DESIGN: 4, SPEAK: 3 }, critical_skills: ['DESIGN'] },
    { role: 'Data Analyst', grade: 'Middle', required_skills: { SQL: 3, SPEAK: 2 }, critical_skills: ['SQL'] },
  ], history,
});

export const cases = [
  {
    id: 'critical-vs-weakest', description: 'Критичный System Design против самого слабого Public Speaking.',
    expectedFirst: ['DESIGN_STEP'],
    data: dataset([event('DESIGN_STEP'), event('SPEAK_STEP', { develops_skills: [{ skill_id: 'SPEAK', gain: 2, max_level: 3 }] })]),
  },
  {
    id: 'repeated-format-setbacks', description: 'Три пропуска короткого онлайн-формата: проверить альтернативное менторство с таким же приростом.',
    expectedFirst: ['MENTOR'],
    data: dataset([
      event('SHORT_ONLINE', { format: 'online', duration_hours: 1, upcoming_sessions: ['2026-10-02'] }),
      event('MENTOR', { type: 'mentoring', format: 'offline', duration_hours: 6, upcoming_sessions: ['2026-10-03'] }),
    ], { history: [1, 2, 3].map(n => ({ record_id: `SKIP${n}`, employee_id: 'SYNTHETIC', event_id: 'SHORT_ONLINE', date: `2026-09-0${n}`, status: 'no_show' })) }),
  },
  {
    id: 'continue-started', description: 'Два равноценных курса: завершить уже начатый.',
    expectedFirst: ['STARTED'],
    data: dataset([event('NEW'), event('STARTED')], { history: [{ record_id: 'START', employee_id: 'SYNTHETIC', event_id: 'STARTED', date: '2026-09-20', status: 'in_progress' }] }),
  },
  {
    id: 'career-switch', description: 'При смене профессии развивать SQL для новой цели, сохраняя допуск по текущей роли.',
    expectedFirst: ['SQL_STEP'],
    data: dataset([event('DESIGN_STEP'), event('SQL_STEP', { develops_skills: [{ skill_id: 'SQL', gain: 1, max_level: 4 }] })],
      { person: { career_goal: { target_role: 'Data Analyst', target_grade: 'Middle' } } }),
  },
  {
    id: 'missing-prerequisite', description: 'Не рекомендовать продвинутый курс с невыполненными предварительными требованиями.',
    expectedFirst: ['FOUNDATION'],
    data: dataset([event('ADVANCED', { prerequisites: { DESIGN: 3 }, develops_skills: [{ skill_id: 'DESIGN', gain: 2, max_level: 5 }] }), event('FOUNDATION')]),
  },
  {
    id: 'skill-ceiling', description: 'Не рекомендовать курс, который уже не повышает навык из-за потолка.',
    expectedFirst: ['USEFUL'],
    data: dataset([event('CAPPED', { develops_skills: [{ skill_id: 'DESIGN', gain: 3, max_level: 2 }] }), event('USEFUL')]),
  },
  {
    id: 'no-eligible-step', description: 'Нет доступного курса — не выдумывать рекомендацию.',
    expectedFirst: [],
    data: dataset([event('UNAVAILABLE', { target_grades: ['Lead'] })]),
  },
];
