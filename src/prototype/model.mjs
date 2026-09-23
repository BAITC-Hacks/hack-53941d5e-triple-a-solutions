export const GRADES = ['Junior', 'Middle', 'Senior', 'Lead'];

export function applyGain(level, gain, ceiling) {
  return Math.max(level, Math.min(level + gain, ceiling, 5));
}

export function createModel(data, demoRules = {}) {
  // Preserve the original demo API for the teammate's pure planning tools.
  // Passing an explicit rules object uses session/points records; backend always does so.
  const legacy = arguments.length < 2 || demoRules instanceof Map;
  const initial = demoRules instanceof Map ? demoRules : new Map();
  if (demoRules instanceof Map) demoRules = {};
  const eventMap = new Map(data.events.map(event => [event.event_id, event]));
  const skillMap = new Map(data.skills.map(skill => [skill.skill_id, skill]));
  const employeeMap = new Map(data.employees.map(employee => [employee.employee_id, employee]));
  const historyMap = new Map();
  for (const row of data.history) {
    if (row.date > data.asOf) continue;
    if (!historyMap.has(row.employee_id)) historyMap.set(row.employee_id, []);
    historyMap.get(row.employee_id).push(row);
  }
  for (const rows of historyMap.values()) rows.sort((a, b) => a.date.localeCompare(b.date) || a.record_id.localeCompare(b.record_id));

  const demoCompletions = new Map([...initial].map(([id, events]) => [id, [...new Set(events)].map((eventId, i) => ({
    id: `projection:${id}:${i}`, eventId, date: data.asOf, action: eventMap.get(eventId)?.title || eventId, points: 0,
  }))]));
  const goals = new Map();
  const repeatable = new Set(demoRules.repeatableEventIds || []);
  const sessionPrograms = demoRules.sessionPrograms || {};
  const recordsFor = employeeId => demoCompletions.get(employeeId) || [];
  const pointsFor = event => sessionPrograms[event.event_id]
    ? sessionPrograms[event.event_id].pointsPerSession
    : (demoRules.pointsByEventType?.[event.type] ?? demoRules.pointsByEventType?.default ?? 0);

  function goalFor(employee) {
    const explicit = goals.get(employee.employee_id) || employee.career_goal;
    if (explicit) return { role: explicit.target_role, grade: explicit.target_grade, assumed: false };
    const next = Math.min(GRADES.indexOf(employee.grade) + 1, GRADES.length - 1);
    return { role: employee.role, grade: GRADES[next], assumed: true };
  }

  function pointLedger(employee) {
    const rows = historyMap.get(employee.employee_id) || [];
    const seen = new Set();
    const historical = [];
    for (const row of rows) {
      if (row.status !== 'completed') continue;
      const event = eventMap.get(row.event_id);
      if (!event) continue;
      const dedupeKey = repeatable.has(event.event_id) ? row.record_id : event.event_id;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const program = sessionPrograms[event.event_id];
      historical.push({
        id: `history:${row.record_id}`,
        eventId: event.event_id,
        date: row.date,
        action: program ? `${event.title}: все сессии` : event.title,
        points: program ? pointsFor(event) * event.upcoming_sessions.length : pointsFor(event),
        source: 'demo-derived',
      });
    }
    const simulated = recordsFor(employee.employee_id).map(record => ({ ...record, source: 'demo-action' }));
    return [...historical, ...simulated].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }

  function programProgress(employee, eventId) {
    const event = eventMap.get(eventId);
    const rule = sessionPrograms[eventId];
    if (!event || !rule) return null;
    const historicalDone = (historyMap.get(employee.employee_id) || []).some(row => row.event_id === eventId && row.status === 'completed');
    const completedRecords = recordsFor(employee.employee_id).filter(row => row.eventId === eventId && row.sessionIndex != null);
    const completed = historicalDone ? event.upcoming_sessions.length : completedRecords.length;
    const total = event.upcoming_sessions.length;
    return {
      event,
      rule,
      completed,
      total,
      pointsEarned: completed * rule.pointsPerSession,
      totalPoints: total * rule.pointsPerSession,
      finished: completed >= total,
      nextSession: completed < total ? event.upcoming_sessions[completed] : null,
      sessions: event.upcoming_sessions.map((sessionDate, index) => ({
        index,
        date: sessionDate,
        label: rule.sessionLabels?.[index] || `Сессия ${index + 1}`,
        completed: historicalDone || completedRecords.some(row => row.sessionIndex === index),
      })),
    };
  }

  function snapshot(employee) {
    const levels = { ...employee.skills };
    const history = historyMap.get(employee.employee_id) || [];
    const done = new Set(history.filter(row => row.status === 'completed').map(row => row.event_id));
    for (const row of history) {
      if (row.status !== 'completed' || row.date <= employee.last_review_date) continue;
      for (const gain of eventMap.get(row.event_id)?.develops_skills || []) {
        levels[gain.skill_id] = applyGain(levels[gain.skill_id] || 0, gain.gain, gain.max_level);
      }
    }
    const simulated = recordsFor(employee.employee_id);
    for (const record of simulated.filter(row => row.sessionIndex == null)) {
      done.add(record.eventId);
      for (const gain of eventMap.get(record.eventId)?.develops_skills || []) {
        levels[gain.skill_id] = applyGain(levels[gain.skill_id] || 0, gain.gain, gain.max_level);
      }
    }
    for (const eventId of Object.keys(sessionPrograms)) {
      const progress = programProgress(employee, eventId);
      if (!progress?.finished || done.has(eventId)) continue;
      done.add(eventId);
      for (const gain of progress.event.develops_skills || []) {
        levels[gain.skill_id] = applyGain(levels[gain.skill_id] || 0, gain.gain, gain.max_level);
      }
    }

    const goal = goalFor(employee);
    const target = data.roleProfiles.find(row => row.role === goal.role && row.grade === goal.grade);
    const requirements = Object.entries(target?.required_skills || {}).map(([id, required]) => ({
      id, name: skillMap.get(id)?.name || id, level: levels[id] || 0, required,
      gap: Math.max(0, required - (levels[id] || 0)), critical: (target?.critical_skills || []).includes(id),
    }));
    requirements.sort((a, b) => Number(b.critical) - Number(a.critical) || b.gap - a.gap || a.name.localeCompare(b.name));
    const total = requirements.reduce((sum, skill) => sum + skill.required, 0);
    const covered = requirements.reduce((sum, skill) => sum + Math.min(skill.level, skill.required), 0);
    const ledger = pointLedger(employee);
    return {
      employee, levels, history, done, goal, requirements, totalRequired: total, covered,
      coverage: total ? Math.round(covered / total * 100) : 100,
      gaps: requirements.filter(skill => skill.gap > 0), simulated: legacy ? simulated.map(row => row.eventId) : simulated,
      pointLedger: ledger, totalPoints: ledger.reduce((sum, row) => sum + row.points, 0),
    };
  }

  function available(employee) {
    const state = snapshot(employee);
    const candidates = [];
    for (const event of data.events) {
      if (event.mandatory || !event.target_roles.includes(employee.role) || !event.target_grades.includes(employee.grade)) continue;
      if (state.done.has(event.event_id) && !repeatable.has(event.event_id)) continue;
      if (Object.entries(event.prerequisites).some(([id, minimum]) => (state.levels[id] || 0) < minimum)) continue;
      const program = programProgress(employee, event.event_id);
      const session = program?.nextSession || [...event.upcoming_sessions].sort().find(item => item >= data.asOf);
      if (event.format !== 'self_paced' && !session && !program?.finished) continue;
      const impact = event.develops_skills.flatMap(gain => {
        const skill = state.requirements.find(item => item.id === gain.skill_id);
        if (!skill?.gap) return [];
        const after = applyGain(skill.level, gain.gain, gain.max_level);
        const reduction = Math.min(skill.required, after) - Math.min(skill.required, skill.level);
        return reduction > 0 ? [{ ...skill, after, reduction, gain: after - skill.level }] : [];
      });
      const skillGains = event.develops_skills.flatMap(gain => {
        const level = state.levels[gain.skill_id] || 0, after = applyGain(level, gain.gain, gain.max_level);
        return after > level ? [{ id: gain.skill_id, name: skillMap.get(gain.skill_id)?.name || gain.skill_id, level, after }] : [];
      });
      if (!skillGains.length) continue;
      const relatedHistory = state.history.filter(row => {
        const historicalEvent = eventMap.get(row.event_id);
        return historicalEvent && historicalEvent.type === event.type && historicalEvent.format === event.format && !historicalEvent.mandatory;
      });
      const successes = relatedHistory.filter(row => row.status === 'completed').length;
      const setbacks = relatedHistory.filter(row => ['dropped', 'declined', 'no_show'].includes(row.status)).length;
      const latest = state.history.filter(row => row.event_id === event.event_id).at(-1);
      const ongoing = latest?.status === 'in_progress' || Boolean(program?.completed);
      const weighted = impact.reduce((sum, item) => sum + item.reduction * (item.critical ? 3 : 1), 0);
      const score = weighted * 10 + weighted / Math.max(1, event.duration_hours) * 4
        + Math.min(successes, 3) - Math.min(setbacks, 3) * 2 + (ongoing ? 2 : 0);
      const coverageAfter = state.totalRequired
        ? Math.round((state.covered + impact.reduce((sum, item) => sum + item.reduction, 0)) / state.totalRequired * 100)
        : 100;
      candidates.push({
        event, impact, skillGains, session, program, successes, setbacks, ongoing, score, coverageAfter,
        points: program ? program.rule.pointsPerSession : pointsFor(event),
      });
    }
    return candidates.sort((a, b) => b.score - a.score || a.event.event_id.localeCompare(b.event.event_id));
  }

  function recommend(employee) { return available(employee).filter(item => item.impact.length); }

  function importantMisses(employee) {
    const state = snapshot(employee);
    const grouped = new Map();
    for (const row of state.history.filter(item => item.status === 'no_show')) {
      const event = eventMap.get(row.event_id);
      if (!event) continue;
      for (const gain of event.develops_skills || []) {
        const skill = state.requirements.find(item => item.id === gain.skill_id && item.gap > 0);
        if (!skill) continue;
        const key = `${event.event_id}:${skill.id}`;
        if (!grouped.has(key)) grouped.set(key, { event, skill, count: 0, dates: [] });
        const item = grouped.get(key);
        item.count++;
        item.dates.push(row.date);
      }
    }
    const recommendations = recommend(employee);
    return [...grouped.values()].map(item => ({
      ...item,
      nextStep: recommendations.find(row => row.impact.some(skill => skill.id === item.skill.id)) || null,
    })).sort((a, b) => Number(b.skill.critical) - Number(a.skill.critical) || b.count - a.count || a.skill.name.localeCompare(b.skill.name));
  }

  function complete(employeeId, eventId) {
    const employee = employeeMap.get(employeeId);
    const recommendation = employee && available(employee).find(item => item.event.event_id === eventId);
    if (!employee || !recommendation) return false;
    if (!demoCompletions.has(employeeId)) demoCompletions.set(employeeId, []);
    const records = demoCompletions.get(employeeId);
    const event = recommendation.event;
    const program = programProgress(employee, eventId);
    if (program) {
      if (program.finished) return false;
      const session = program.sessions.find(item => !item.completed);
      records.push({ id: `demo:${employeeId}:${eventId}:session:${session.index}`, eventId, sessionIndex: session.index,
        date: data.asOf, action: `${event.title}: ${session.label}`, points: program.rule.pointsPerSession });
      const updated = programProgress(employee, eventId);
      return { kind: 'session', points: program.rule.pointsPerSession, completed: updated.completed, total: updated.total, finished: updated.finished };
    }
    if (!repeatable.has(eventId) && records.some(row => row.eventId === eventId)) return false;
    const occurrence = records.filter(row => row.eventId === eventId).length;
    records.push({ id: `demo:${employeeId}:${eventId}:${occurrence}`, eventId, date: data.asOf, action: event.title, points: pointsFor(event) });
    return legacy ? true : { kind: 'activity', points: pointsFor(event), finished: true };
  }

  function setGoal(employeeId, role, grade) {
    if (!data.roleProfiles.some(item => item.role === role && item.grade === grade)) return false;
    goals.set(employeeId, { target_role: role, target_grade: grade });
    return true;
  }

  function overview() {
    const states = data.employees.map(snapshot);
    const shortages = new Map();
    for (const state of states) for (const skill of state.gaps) {
      if (!shortages.has(skill.id)) shortages.set(skill.id, { id: skill.id, name: skill.name, count: 0 });
      shortages.get(skill.id).count++;
    }
    const noSteps = states.filter(state => state.gaps.length && !recommend(state.employee).length);
    const misses = data.history.filter(row => row.status === 'no_show');
    const eventMisses = new Map();
    for (const row of misses) {
      const event = eventMap.get(row.event_id);
      if (!eventMisses.has(row.event_id)) eventMisses.set(row.event_id, { event, count: 0, employees: new Set() });
      const item = eventMisses.get(row.event_id); item.count++; item.employees.add(row.employee_id);
    }
    const importantByPerson = states.map(state => {
      const missesForPerson = importantMisses(state.employee);
      const relevantEventIds = new Set(missesForPerson.map(miss => miss.event.event_id));
      const importantCount = state.history.filter(row => row.status === 'no_show' && relevantEventIds.has(row.event_id)).length;
      return { state, misses: missesForPerson, importantCount };
    });
    const missedByPerson = importantByPerson.filter(item => item.importantCount >= 2)
      .sort((a, b) => a.state.employee.full_name.localeCompare(b.state.employee.full_name));
    const missedSkills = new Map();
    for (const item of importantByPerson) for (const miss of item.misses) {
      if (!missedSkills.has(miss.skill.id)) missedSkills.set(miss.skill.id, { id: miss.skill.id, name: miss.skill.name, misses: 0, employees: new Set() });
      const skill = missedSkills.get(miss.skill.id); skill.misses += miss.count; skill.employees.add(item.state.employee.employee_id);
    }
    const departments = new Map();
    for (const item of importantByPerson) {
      const name = item.state.employee.department;
      if (!departments.has(name)) departments.set(name, { name, employees: 0, misses: 0, importantMisses: 0 });
      const department = departments.get(name); department.employees++;
      department.misses += item.state.history.filter(row => row.status === 'no_show').length;
      department.importantMisses += item.importantCount;
    }
    const activityCount = data.history.filter(row => row.status === 'completed').length
      + [...demoCompletions.values()].reduce((sum, items) => sum + items.length, 0);
    return {
      states, noSteps, activityCount, noGoal: states.filter(state => state.goal.assumed).length, totalMisses: misses.length,
      repeatedImportantMisses: missedByPerson,
      eventMisses: [...eventMisses.values()].map(item => ({ ...item, employees: item.employees.size }))
        .sort((a, b) => b.count - a.count || a.event.event_id.localeCompare(b.event.event_id)),
      missedSkills: [...missedSkills.values()].map(item => ({ ...item, employees: item.employees.size }))
        .sort((a, b) => b.misses - a.misses || a.id.localeCompare(b.id)),
      departments: [...departments.values()].sort((a, b) => a.name.localeCompare(b.name)),
      shortages: [...shortages.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    };
  }

  return {
    progress() {
      return [...new Set([...goals.keys(), ...demoCompletions.keys()])].sort().map(employeeId => {
        const base = employeeMap.get(employeeId)?.career_goal, selected = goals.get(employeeId);
        const changed = selected && (selected.target_role !== base?.target_role || selected.target_grade !== base?.target_grade);
        return { employeeId, goal: changed ? { role: selected.target_role, grade: selected.target_grade } : null,
          simulated: recordsFor(employeeId).map(r => r.eventId) };
      }).filter(row => row.goal || row.simulated.length);
    },
    snapshot, available, recommend, complete, setGoal, overview, importantMisses, programProgress, pointsFor,
    eventMap, skillMap, demoRules,
    reset() { demoCompletions.clear(); goals.clear(); },
  };
}
