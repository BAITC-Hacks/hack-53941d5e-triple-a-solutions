export function requestFor(state) {
  return {
    employeeId: state.employee.employee_id,
    goal: state.goal.assumed ? null : { role: state.goal.role, grade: state.goal.grade },
    simulated: state.simulated,
  };
}

// Each result belongs to an exact profile/goal/completion state; late responses cannot replace another profile.
export function createAiClient(fetchImpl = fetch) {
  const states = new Map();
  const controllers = new Set();
  let generation = 0;
  const keyFor = state => JSON.stringify(requestFor(state));
  return {
    get(state) { return states.get(keyFor(state)) || { status: 'idle' }; },
    async request(state) {
      const key = keyFor(state);
      if (states.get(key)?.status === 'loading') return;
      const version = generation;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 10_000);
      states.set(key, { status: 'loading' });
      try {
        const response = await fetchImpl('/api/recommendations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: key, signal: controller.signal,
        });
        if (!response.ok) throw new Error('unavailable');
        const result = await response.json();
        if (!['ai', 'rules'].includes(result.source) || !Array.isArray(result.recommendations)) throw new Error('invalid');
        if (generation === version) states.set(key, { status: 'done', result });
      } catch {
        if (generation === version) states.set(key, { status: 'done', result: {
          source: 'rules', recommendations: [], message: 'AI не ответил. Доступен подбор по правилам; попробуйте ещё раз.',
        } });
      } finally { clearTimeout(timer); controllers.delete(controller); }
      if (states.size > 100) states.delete(states.keys().next().value);
    },
    reset() {
      generation++;
      for (const controller of controllers) controller.abort();
      controllers.clear(); states.clear();
    },
  };
}
