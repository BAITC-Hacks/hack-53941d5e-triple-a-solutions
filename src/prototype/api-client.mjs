// Transport adapter: rendering keeps the existing model-shaped contract.
export async function connectBackend(root) {
  const health = await fetch('/api/health');
  if (health.status === 404) return null; // Original Python-only prototype mode.
  if (!health.ok) throw new Error('Backend недоступен');
  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error?.message || 'Ошибка запроса'); error.status = response.status; throw error; }
    return result;
  }
  let data;
  try { data = await request('/api/bootstrap'); }
  catch (error) {
    if (error.status !== 401) throw error;
    root.innerHTML = `<main class="loading"><h1>Career Quest</h1><p>Введите ключ сотрудника или HR, выданный администратором.</p><form id="login-form"><label class="form-field">Ключ доступа<input name="token" type="password" required autocomplete="off"></label><button class="button">Войти</button><p id="login-error" role="alert"></p></form></main>`;
    await new Promise(resolve => {
      const form = document.querySelector('#login-form');
      form.addEventListener('submit', async event => {
        event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
        try { await request('/api/auth/session', { method: 'POST', body: JSON.stringify({ token: new FormData(form).get('token') }) }); form.reset(); resolve(); }
        catch (error) { document.querySelector('#login-error').textContent = error.message; }
        finally { button.disabled = false; }
      });
    });
    data = await request('/api/bootstrap');
  }
  const profiles = new Map(), catalog = new Map(), recommendations = new Map();
  let overview;
  const id = data.user.employeeId;
  async function refresh() {
    const [profile, recs, events] = await Promise.all([
      request(`/api/employees/${id}`), request(`/api/employees/${id}/recommendations`), request(`/api/employees/${id}/events`),
    ]);
    profiles.set(id, profile); catalog.set(id, events.events); recommendations.set(id, recs.recommendations);
    data.employees = [profile.employee];
  }
  const model = {
    isBackend: true,
    eventMap: new Map(data.events.map(e => [e.event_id, e])),
    skillMap: new Map(data.skills.map(s => [s.skill_id, s])), demoRules: data.demoRules,
    snapshot: employee => profiles.get(employee.employee_id),
    recommend: employee => recommendations.get(employee.employee_id) || [],
    importantMisses: employee => profiles.get(employee.employee_id)?.warnings || [],
    programProgress: (employee, eventId) => catalog.get(employee.employee_id)?.find(c => c.event.event_id === eventId)?.program,
    catalog: () => catalog.get(id) || [],
    overview: () => overview,
    async loadHr() {
      overview = await request('/api/hr/overview');
      for (const state of overview.states) profiles.set(state.employee.employee_id, state);
    },
    async hrProfile(employeeId) { const state = await request(`/api/hr/employees/${employeeId}`); profiles.set(employeeId, state); return state; },
    async setGoal(employeeId, role, grade) {
      await request(`/api/employees/${employeeId}/goal`, { method: 'PUT', body: JSON.stringify({ role, grade }) }); await refresh(); return true;
    },
    async complete(employeeId, eventId, selectedSession) {
      const item = catalog.get(employeeId).find(c => c.event.event_id === eventId);
      const session_id = selectedSession || item.completionSessionId;
      const storageKey = `cq:${employeeId}:${eventId}:${session_id || 'once'}`;
      const key = sessionStorage.getItem(storageKey) || crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      const result = await request(`/api/employees/${employeeId}/events/${eventId}/complete`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(session_id ? { session_id } : {}) });
      await refresh(); return result;
    },
    reset: refresh,
    logout: () => request('/api/auth/session', { method: 'DELETE' }),
  };
  await refresh();
  return { data, model, employeeId: id, demoRules: data.demoRules };
}
