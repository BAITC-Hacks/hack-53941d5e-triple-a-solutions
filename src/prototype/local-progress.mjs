import { createModel } from './model.mjs';

export const STORAGE_KEY = 'career-quest-demo-v2';
export function datasetVersion(data) {
  let hash = 2166136261;
  for (const char of JSON.stringify(data)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

export function restoreProgress(data, storage) {
  const version = datasetVersion(data);
  const empty = () => ({ model: createModel(data), plans: {}, drafts: {}, version });
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 2_000_000) return empty();
    const saved = JSON.parse(raw);
    if (saved.version !== version || !Array.isArray(saved.profiles)) return empty();
    const validEvents = new Set(data.events.map(e => e.event_id));
    const completions = new Map();
    for (const profile of saved.profiles) {
      if (!data.employees.some(e => e.employee_id === profile.id) || !Array.isArray(profile.completed)
        || profile.completed.length > data.events.length || new Set(profile.completed).size !== profile.completed.length
        || profile.completed.some(id => !validEvents.has(id))) continue;
      completions.set(profile.id, profile.completed);
    }
    const model = createModel(data, completions);
    for (const profile of saved.profiles) if (profile.goal && data.employees.some(e => e.employee_id === profile.id)) model.setGoal(profile.id, profile.goal.role, profile.goal.grade);
    // UI validates saved drafts and reconstructs numerical plan projections before use.
    const dictionary = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return { model, plans: dictionary(saved.plans), drafts: dictionary(saved.drafts), version };
  } catch { return empty(); }
}

export function saveProgress(data, model, extra, storage) {
  try {
    const profiles = data.employees.map(employee => {
      const state = model.snapshot(employee);
      return { id: employee.employee_id, completed: state.simulated,
        goal: state.goal.assumed ? null : { role: state.goal.role, grade: state.goal.grade } };
    });
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: extra.version, profiles, plans: extra.plans, drafts: extra.drafts }));
    return true;
  } catch { return false; }
}
