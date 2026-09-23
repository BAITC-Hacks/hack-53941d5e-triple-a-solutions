import { createModel, applyGain } from '../prototype/model.mjs';
import { fail } from './store.mjs';
import { isDate, STATUSES } from './validate.mjs';

export class CareerService {
  constructor(store, asOf = store.data.asOf) {
    if (!isDate(asOf) || asOf < store.data.asOf) fail(422, 'INVALID_CLOCK', 'Модельная дата должна быть не раньше среза датасета');
    if ((store.db.prepare('SELECT MAX(date) AS latest FROM completions').get().latest || '') > asOf) fail(422, 'CLOCK_BEFORE_COMPLETION', 'Модельная дата раньше сохранённых завершений');
    Object.assign(this, { store, asOf, data: store.data, rules: store.rules });
    this.events = new Map(this.data.events.map(e => [e.event_id, e]));
    this.originalEmployees = new Map(this.data.employees.map(e => [e.employee_id, e]));
    const baseline = createModel(this.data, this.rules);
    this.historicalLedger = new Map(this.data.employees.map(e => [e.employee_id, baseline.snapshot(e).pointLedger]));
  }
  context() {
    const states = new Map(this.store.db.prepare('SELECT * FROM employees').all().map(e => [e.id, e]));
    const records = this.store.db.prepare('SELECT * FROM completions ORDER BY id').all();
    const employees = this.data.employees.map(e => ({ ...e, skills: JSON.parse(states.get(e.employee_id).skills), career_goal: JSON.parse(states.get(e.employee_id).goal || 'null'), last_review_date: this.asOf }));
    const history = [...this.data.history, ...records.map(r => ({ record_id: `completion_${r.id}`, employee_id: r.employee_id, event_id: r.event_id,
      session_id: r.session_id, date: r.date, completed_at: r.completed_at, status: r.finished ? 'completed' : 'in_progress', entity_kind: r.session_id ? 'session' : 'activity',
      completion_pct: r.finished ? 100 : null, score: null, feedback_rating: null, assigned_by: 'employee' }))];
    const effective = { ...this.data, asOf: this.asOf, employees, history };
    return { model: createModel(effective, this.rules), employees, history, records };
  }
  employee(id, ctx) { return ctx.employees.find(e => e.employee_id === id) || fail(404, 'EMPLOYEE_NOT_FOUND', 'Сотрудник не найден'); }
  snapshot(id, ctx = this.context()) {
    const employee = this.employee(id, ctx);
    const state = ctx.model.snapshot(employee);
    state.employee = { ...employee, last_review_date: this.originalEmployees.get(id).last_review_date };
    state.done = [...state.done]; state.simulated = [];
    state.pointLedger = [...this.historicalLedger.get(id), ...ctx.records.filter(r => r.employee_id === id).map(r => ({ id: `completion:${r.id}`, eventId: r.event_id,
      session_id: r.session_id, date: r.date, action: this.events.get(r.event_id).title + (r.session_id ? `: сессия ${r.session_id.split(':')[1]}` : ''), points: r.points, source: 'server', policyVersion: r.policy_version }))]
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    state.totalPoints = state.pointLedger.reduce((sum, r) => sum + r.points, 0);
    state.asOf = this.asOf;
    state.limitations = ['Историческая date самостоятельного курса используется как приближение даты завершения.', 'Исторические пойнты рассчитаны по временной политике demo-rules.json.'];
    return state;
  }
  eligibility(employee, event, levels) {
    const reasons = [];
    if (!event.target_roles.includes(employee.role)) reasons.push('ROLE_NOT_ALLOWED');
    if (!event.target_grades.includes(employee.grade)) reasons.push('GRADE_NOT_ALLOWED');
    if (Object.entries(event.prerequisites).some(([id, n]) => (levels[id] || 0) < n)) reasons.push('PREREQUISITES_NOT_MET');
    return reasons;
  }
  catalog(id, ctx = this.context(), state = this.snapshot(id, ctx)) {
    return this.data.events.map(event => {
      const programRule = this.rules.sessionPrograms[event.event_id];
      const repeatable = this.rules.repeatableEventIds.includes(event.event_id);
      const records = ctx.records.filter(r => r.employee_id === id && r.event_id === event.event_id);
      const history = this.data.history.filter(r => r.employee_id === id && r.event_id === event.event_id);
      const historicalDone = history.some(r => r.status === 'completed');
      const finished = !repeatable && (historicalDone || records.some(r => r.finished));
      const reasons = this.eligibility(state.employee, event, state.levels);
      const sessions = [...event.upcoming_sessions].sort().map((date, index) => {
        const session_id = `${event.event_id}:${date}`;
        const done = records.some(r => r.session_id === session_id) || (repeatable && history.some(r => r.status === 'completed' && r.date === date));
        const prior = history.filter(r => r.date === date).at(-1);
        return { session_id, index, date, label: programRule?.sessionLabels[index] || `Сессия ${index + 1}`, completed: done,
          status: date > this.asOf ? 'scheduled' : 'available_for_completion', participationStatus: done ? 'completed' : (prior?.status || 'not_started'),
          canComplete: !finished && !done && date <= this.asOf && reasons.length === 0 };
      });
      const pending = sessions.filter(s => !s.completed);
      const completable = pending.find(s => s.canComplete);
      const next = completable || pending.find(s => s.date >= this.asOf);
      const count = historicalDone && programRule ? sessions.length : records.filter(r => r.session_id).length;
      const program = programRule ? { event, rule: programRule, completed: count, total: sessions.length, pointsEarned: count * programRule.pointsPerSession,
        totalPoints: sessions.length * programRule.pointsPerSession, finished, historicalCompletion: historicalDone,
        nextSession: next?.date || null, sessions,
        skillImpacts: event.develops_skills.flatMap(g => {
          const skill = state.requirements.find(s => s.id === g.skill_id);
          return skill ? [{ ...skill, after: applyGain(skill.level, g.gain, g.max_level) }] : [];
        }) } : null;
      const points = programRule?.pointsPerSession ?? this.rules.pointsByEventType[event.type] ?? this.rules.pointsByEventType.default;
      const canComplete = reasons.length === 0 && !finished && (event.format === 'self_paced' && !programRule || Boolean(completable));
      const availableForRecommendation = reasons.length === 0 && !finished && (event.format === 'self_paced' || pending.some(s => s.date >= this.asOf) || Boolean(program && count > 0 && pending.length));
      return { event, sessionCount: sessions.length, sessions, program, repeatPolicy: repeatable ? 'per_session' : 'once', repeatAllowed: repeatable,
        completed: finished, status: finished ? 'completed' : records.length ? 'in_progress' : history.at(-1)?.status || 'not_started',
        canComplete, completionSessionId: completable?.session_id || null, pointsReward: points, availableForRecommendation,
        unavailableReasons: [...reasons, ...(finished ? ['ALREADY_COMPLETED'] : []), ...(!canComplete && !finished && reasons.length === 0 ? ['NO_COMPLETABLE_SESSION'] : [])] };
    });
  }
  recommendations(id, ctx = this.context(), state = this.snapshot(id, ctx)) {
    const catalog = new Map(this.catalog(id, ctx, state).map(c => [c.event.event_id, c]));
    // Existing deterministic ranking and impact calculation remain the source of recommendation facts.
    const all = ctx.model.recommend(this.employee(id, ctx)).filter(r => catalog.get(r.event.event_id).availableForRecommendation).map(r => {
      const item = catalog.get(r.event.event_id);
      const session = item.sessions.find(s => s.session_id === item.completionSessionId)?.date || item.program?.nextSession || item.sessions.find(s => !s.completed && s.date >= this.asOf)?.date || null;
      const breakdown = Object.fromEntries(STATUSES.map(status => [status, state.history.filter(h => {
        const e = this.events.get(h.event_id);
        return e.type === r.event.type && e.format === r.event.format && !e.mandatory && h.status === status;
      }).length]));
      return { ...r, session, program: item.program, coverage: state.coverage, canComplete: item.canComplete, session_id: item.completionSessionId,
        repeatAllowed: item.repeatAllowed, historyBreakdown: breakdown,
        explanation: r.impact.map(s => `${s.name}: ${s.level} → ${s.after}; для цели требуется ${s.required}${s.critical ? ' (ключевой навык)' : ''}.`).join(' '),
        reasonCodes: ['ROLE_ALLOWED', 'GRADE_ALLOWED', 'PREREQUISITES_MET', 'REDUCES_GOAL_GAP'],
        impact: r.impact.map(s => ({ ...s, max_level: r.event.develops_skills.find(g => g.skill_id === s.id).max_level })) };
    });
    const recommendations = all.slice(0, 3);
    return { recommendations, emptyReason: recommendations.length ? null : state.gaps.length ? 'NO_ELIGIBLE_ACTIVITIES' : 'GOAL_REQUIREMENTS_MET', asOf: this.asOf };
  }
  misses(id, ctx, state, recs) {
    const grouped = new Map();
    for (const h of state.history.filter(r => r.status === 'no_show')) {
      const event = this.events.get(h.event_id);
      for (const gain of event.develops_skills) {
        const skill = state.gaps.find(s => s.id === gain.skill_id);
        if (!skill || applyGain(skill.level, gain.gain, gain.max_level) <= skill.level) continue;
        const key = `${event.event_id}:${skill.id}`;
        if (!grouped.has(key)) grouped.set(key, { event, skill, count: 0, dates: [], nextStep: recs.find(r => r.impact.some(s => s.id === skill.id)) || null,
          code: 'MISSED_GOAL_SKILL', message: `Пропущена возможность развить ${skill.name}. До требования цели остаётся ${skill.gap} ур. Достигнутый уровень и пойнты сохранены.` });
        const miss = grouped.get(key); miss.count++; miss.dates.push(h.date);
      }
    }
    return [...grouped.values()].sort((a, b) => Number(b.skill.critical) - Number(a.skill.critical) || b.count - a.count || a.skill.id.localeCompare(b.skill.id));
  }
  profile(id, ctx = this.context()) {
    const state = this.snapshot(id, ctx), result = this.recommendations(id, ctx, state);
    state.warnings = this.misses(id, ctx, state, result.recommendations);
    return state;
  }
  setGoal(id, { role, grade }) {
    const ctx = this.context(); this.employee(id, ctx);
    if (!this.data.roleProfiles.some(p => p.role === role && p.grade === grade)) fail(422, 'INVALID_GOAL', 'Такой цели нет в справочнике');
    this.store.db.prepare('UPDATE employees SET goal=? WHERE id=?').run(JSON.stringify({ target_role: role, target_grade: grade }), id);
    return this.profile(id);
  }
  complete(id, eventId, sessionId, key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_:-]{8,128}$/.test(key)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен Idempotency-Key длиной 8–128 символов');
    const payload = JSON.stringify({ eventId, sessionId: sessionId ?? null });
    return this.store.transaction(() => {
      const cached = this.store.db.prepare('SELECT * FROM requests WHERE employee_id=? AND key=?').get(id, key);
      if (cached) {
        if (cached.payload !== payload) fail(409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован для другого действия');
        return JSON.parse(cached.response);
      }
      const ctx = this.context(), state = this.snapshot(id, ctx);
      const item = this.catalog(id, ctx, state).find(c => c.event.event_id === eventId);
      if (!item) fail(404, 'EVENT_NOT_FOUND', 'Активность не найдена');
      if (item.completed) fail(409, 'ALREADY_COMPLETED', 'Одноразовая активность уже завершена');
      const reasons = this.eligibility(state.employee, item.event, state.levels);
      if (reasons.length) fail(422, 'NOT_ELIGIBLE', 'Условия допуска не выполнены', reasons);
      const needsSession = Boolean(item.program) || item.event.format !== 'self_paced';
      let session;
      if (needsSession) {
        session = item.sessions.find(s => s.session_id === sessionId);
        if (!session) fail(422, 'INVALID_SESSION', 'Выберите сессию из каталога');
        if (session.completed) fail(409, 'ALREADY_COMPLETED', 'Сессия уже завершена');
        if (session.date > this.asOf) fail(422, 'FUTURE_SESSION', 'Будущую сессию нельзя отметить завершённой');
      } else if (sessionId != null) fail(422, 'INVALID_SESSION', 'У самостоятельного курса нет сессий');
      const occurrence = item.repeatAllowed || item.program ? session.session_id : 'once';
      const finished = !item.program || item.program.completed + 1 === item.program.total;
      const levels = { ...state.levels }, skillChanges = [];
      if (finished) for (const gain of item.event.develops_skills) {
        const before = levels[gain.skill_id] || 0, after = applyGain(before, gain.gain, gain.max_level);
        levels[gain.skill_id] = after;
        skillChanges.push({ skill_id: gain.skill_id, before, after, gainApplied: after - before });
      }
      const completedAt = new Date().toISOString();
      const result = this.store.db.prepare(`INSERT INTO completions(employee_id,event_id,occurrence,session_id,date,completed_at,points,skill_changes,finished,policy_version)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, eventId, occurrence, session?.session_id || null, this.asOf, completedAt, item.pointsReward, JSON.stringify(skillChanges), Number(finished), this.store.version);
      this.store.db.prepare('UPDATE employees SET skills=? WHERE id=?').run(JSON.stringify(levels), id);
      const profile = this.profile(id);
      const response = { kind: item.program ? 'session' : 'activity', points: item.pointsReward, pointsAwarded: item.pointsReward, totalPoints: profile.totalPoints,
        completed: item.program ? item.program.completed + 1 : 1, total: item.program?.total || 1, finished,
        completion: { id: Number(result.lastInsertRowid), event_id: eventId, session_id: session?.session_id || null, completed_at: completedAt, date: this.asOf },
        skillChanges, profile, warnings: profile.warnings };
      this.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(id, key, payload, JSON.stringify(response));
      return response;
    });
  }
  overview() {
    const ctx = this.context();
    const states = ctx.employees.map(e => this.profile(e.employee_id, ctx)).sort((a, b) => a.employee.full_name.localeCompare(b.employee.full_name));
    const shortages = new Map(), eventMisses = new Map(), missedSkills = new Map(), departments = new Map();
    const repeatedImportantMisses = [], noSteps = [];
    for (const state of states) {
      const recs = this.recommendations(state.employee.employee_id, ctx, state).recommendations;
      if (state.gaps.length && !recs.length) noSteps.push(state);
      for (const skill of state.gaps) { const s = shortages.get(skill.id) || { id: skill.id, name: skill.name, count: 0 }; s.count++; shortages.set(skill.id, s); }
      const relevant = new Set(state.warnings.map(m => m.event.event_id));
      const misses = state.history.filter(h => h.status === 'no_show');
      const importantCount = misses.filter(h => relevant.has(h.event_id)).length;
      if (importantCount >= 2) repeatedImportantMisses.push({ state, misses: state.warnings, importantCount });
      for (const miss of misses) { const s = eventMisses.get(miss.event_id) || { event: this.events.get(miss.event_id), count: 0, employees: new Set() }; s.count++; s.employees.add(state.employee.employee_id); eventMisses.set(miss.event_id, s); }
      for (const miss of state.warnings) { const s = missedSkills.get(miss.skill.id) || { id: miss.skill.id, name: miss.skill.name, misses: 0, employees: new Set() }; s.misses += miss.count; s.employees.add(state.employee.employee_id); missedSkills.set(s.id, s); }
      const name = state.employee.department, d = departments.get(name) || { name, employees: 0, misses: 0, importantMisses: 0 };
      d.employees++; d.misses += misses.length; d.importantMisses += importantCount; departments.set(name, d);
    }
    return { states, employeeCount: states.length, noSteps, noGoal: states.filter(s => s.goal.assumed).length,
      employeesWithoutGoal: states.filter(s => s.goal.assumed).map(s => s.employee),
      shortages: [...shortages.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
      totalMisses: ctx.history.filter(h => h.status === 'no_show').length,
      participation: Object.fromEntries(STATUSES.map(s => [s, ctx.history.filter(h => h.status === s).length])),
      completedSessions: ctx.records.filter(r => r.session_id).length,
      activityCount: ctx.history.filter(h => h.status === 'completed').length,
      repeatedImportantMisses: repeatedImportantMisses.sort((a, b) => a.state.employee.full_name.localeCompare(b.state.employee.full_name)),
      eventMisses: [...eventMisses.values()].map(s => ({ ...s, employees: s.employees.size })).sort((a, b) => b.count - a.count),
      missedSkills: [...missedSkills.values()].map(s => ({ ...s, employees: s.employees.size })).sort((a, b) => b.misses - a.misses),
      departments: [...departments.values()].sort((a, b) => a.name.localeCompare(b.name)), asOf: this.asOf };
  }
}
