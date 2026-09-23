export const GRADES = ['Junior', 'Middle', 'Senior', 'Lead'];

export function applyGain(level, gain, ceiling) {
  return Math.max(level, Math.min(level + gain, ceiling, 5));
}

export function createModel(data, initialCompletions = new Map()) {
  const eventMap = new Map(data.events.map(event => [event.event_id, event]));
  const skillMap = new Map(data.skills.map(skill => [skill.skill_id, skill]));
  const historyMap = new Map();
  for (const row of data.history) {
    if (row.date > data.asOf) continue;
    if (!historyMap.has(row.employee_id)) historyMap.set(row.employee_id, []);
    historyMap.get(row.employee_id).push(row);
  }
  for (const rows of historyMap.values()) rows.sort((a, b) => a.date.localeCompare(b.date) || a.record_id.localeCompare(b.record_id));
  const simulated = new Map([...initialCompletions].map(([id, events]) => [id, new Set(events)]));
  const goals = new Map();

  function goalFor(employee) {
    const explicit = goals.get(employee.employee_id) || employee.career_goal;
    if (explicit) return { role: explicit.target_role, grade: explicit.target_grade, assumed: false };
    const next = Math.min(GRADES.indexOf(employee.grade) + 1, GRADES.length - 1);
    return { role: employee.role, grade: GRADES[next], assumed: true };
  }

  function snapshot(employee) {
    const levels = { ...employee.skills };
    const history = historyMap.get(employee.employee_id) || [];
    const done = new Set(history.filter(row => row.status === 'completed').map(row => row.event_id));
    for (const row of history) {
      // CSV has no completion date; README documents this approximation for self-paced events.
      if (row.status !== 'completed' || row.date <= employee.last_review_date) continue;
      for (const gain of eventMap.get(row.event_id)?.develops_skills || []) {
        levels[gain.skill_id] = applyGain(levels[gain.skill_id] || 0, gain.gain, gain.max_level);
      }
    }
    for (const id of simulated.get(employee.employee_id) || []) {
      done.add(id);
      for (const gain of eventMap.get(id).develops_skills) {
        levels[gain.skill_id] = applyGain(levels[gain.skill_id] || 0, gain.gain, gain.max_level);
      }
    }
    const goal = goalFor(employee);
    const target = data.roleProfiles.find(row => row.role === goal.role && row.grade === goal.grade);
    const requirements = Object.entries(target?.required_skills || {}).map(([id, required]) => ({
      id, name: skillMap.get(id)?.name || id, level: levels[id] || 0, required,
      gap: Math.max(0, required - (levels[id] || 0)), critical: target.critical_skills.includes(id),
    }));
    requirements.sort((a, b) => Number(b.critical) - Number(a.critical) || b.gap - a.gap || a.name.localeCompare(b.name));
    const total = requirements.reduce((sum, skill) => sum + skill.required, 0);
    const covered = requirements.reduce((sum, skill) => sum + Math.min(skill.level, skill.required), 0);
    return { employee, levels, history, done, goal, requirements,
      coverage: total ? Math.round(covered / total * 100) : 100,
      gaps: requirements.filter(skill => skill.gap > 0),
      simulated: [...(simulated.get(employee.employee_id) || [])],
    };
  }

  function recommend(employee) {
    const state = snapshot(employee);
    const candidates = [];
    for (const event of data.events) {
      if (event.mandatory || !event.target_roles.includes(employee.role) || !event.target_grades.includes(employee.grade)) continue;
      if (state.done.has(event.event_id) && event.event_id !== 'EV_036') continue;
      if (state.simulated.includes(event.event_id)) continue;
      if (Object.entries(event.prerequisites).some(([id, minimum]) => (state.levels[id] || 0) < minimum)) continue;
      const session = [...event.upcoming_sessions].sort().find(date => date >= data.asOf);
      if (event.format !== 'self_paced' && !session) continue;
      const impact = event.develops_skills.flatMap(gain => {
        const skill = state.requirements.find(item => item.id === gain.skill_id);
        if (!skill?.gap) return [];
        const after = applyGain(skill.level, gain.gain, gain.max_level);
        const reduction = Math.min(skill.required, after) - Math.min(skill.required, skill.level);
        return reduction > 0 ? [{ ...skill, after, reduction }] : [];
      });
      if (!impact.length) continue;
      const relatedHistory = state.history.filter(row => {
        const historicalEvent = eventMap.get(row.event_id);
        return historicalEvent && historicalEvent.type === event.type && historicalEvent.format === event.format && !historicalEvent.mandatory;
      });
      const successes = relatedHistory.filter(row => row.status === 'completed').length;
      const setbacks = relatedHistory.filter(row => ['dropped', 'declined', 'no_show'].includes(row.status)).length;
      const latest = state.history.filter(row => row.event_id === event.event_id).at(-1);
      const ongoing = latest?.status === 'in_progress';
      const weighted = impact.reduce((sum, item) => sum + item.reduction * (item.critical ? 3 : 1), 0);
      const score = weighted * 10 + weighted / Math.max(1, event.duration_hours) * 4
        + Math.min(successes, 3) - Math.min(setbacks, 3) * 2 + (ongoing ? 2 : 0);
      candidates.push({ event, impact, session, successes, setbacks, ongoing, score });
    }
    return candidates.sort((a, b) => b.score - a.score || a.event.event_id.localeCompare(b.event.event_id));
  }

  function complete(employeeId, eventId) {
    const employee = data.employees.find(row => row.employee_id === employeeId);
    if (!employee || !recommend(employee).some(item => item.event.event_id === eventId)) return false;
    if (!simulated.has(employeeId)) simulated.set(employeeId, new Set());
    simulated.get(employeeId).add(eventId);
    return true;
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
    const activityCount = data.history.filter(row => row.status === 'completed').length
      + [...simulated.values()].reduce((sum, items) => sum + items.size, 0);
    return { states, noSteps, activityCount,
      noGoal: states.filter(state => state.goal.assumed).length,
      shortages: [...shortages.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    };
  }

  return { snapshot, recommend, complete, setGoal, overview, eventMap, skillMap,
    reset() { simulated.clear(); goals.clear(); },
  };
}
