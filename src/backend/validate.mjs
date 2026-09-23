import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATUSES = ['completed', 'declined', 'dropped', 'no_show', 'overdue', 'in_progress'];
export const GRADES = ['Junior', 'Middle', 'Senior', 'Lead'];
export const isDate = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x;
export const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x);
const level = x => Number.isInteger(x) && x >= 0 && x <= 5;

export function validateDataset(input, rules) {
  const errors = [];
  const check = (condition, path, message) => { if (!condition) errors.push({ path, message }); };
  const data = structuredClone(input);
  if (!object(data) || !object(rules)) return { valid: false, errors: [{ path: '$', message: 'Dataset and rules must be objects' }] };
  check(isDate(data.asOf), 'asOf', 'Expected YYYY-MM-DD');
  for (const name of ['employees', 'skills', 'events', 'roleProfiles', 'history']) {
    check(Array.isArray(data[name]), name, 'Expected array');
    if (Array.isArray(data[name])) data[name].forEach((row, i) => check(object(row), `${name}[${i}]`, 'Expected object'));
  }
  if (errors.length) return { valid: false, errors };
  for (const name of ['employees', 'skills', 'events', 'roleProfiles']) check(data[name].length > 0, name, 'Must not be empty');
  const sets = {};
  for (const [name, key] of [['employees', 'employee_id'], ['skills', 'skill_id'], ['events', 'event_id'], ['history', 'record_id']]) {
    sets[name] = new Set();
    data[name].forEach((row, i) => {
      check(id(row[key]), `${name}[${i}].${key}`, 'Invalid identifier');
      check(!sets[name].has(row[key]), `${name}[${i}].${key}`, 'Duplicate identifier');
      sets[name].add(row[key]);
    });
  }
  const skillLevels = (map, path) => {
    check(object(map), path, 'Expected skill-to-level object');
    if (object(map)) for (const [key, value] of Object.entries(map)) {
      check(sets.skills.has(key), `${path}.${key}`, 'Unknown skill');
      check(level(value), `${path}.${key}`, 'Expected integer level 0–5');
    }
  };
  const profiles = new Set();
  data.roleProfiles.forEach((r, i) => {
    const p = `roleProfiles[${i}]`, key = `${r.role}:${r.grade}`;
    check(typeof r.role === 'string' && r.role.length > 0, `${p}.role`, 'Required role');
    check(GRADES.includes(r.grade), `${p}.grade`, 'Unknown grade');
    check(!profiles.has(key), p, 'Duplicate role/grade'); profiles.add(key);
    skillLevels(r.required_skills, `${p}.required_skills`);
    check(Array.isArray(r.critical_skills) && r.critical_skills.every(s => Object.hasOwn(r.required_skills || {}, s)), `${p}.critical_skills`, 'Critical skills must be required skills');
  });
  data.skills.forEach((s, i) => check(typeof s.name === 'string' && s.name.length > 0, `skills[${i}].name`, 'Required name'));
  data.employees.forEach((e, i) => {
    const p = `employees[${i}]`;
    for (const field of ['full_name', 'department']) check(typeof e[field] === 'string' && e[field].length > 0, `${p}.${field}`, 'Required string');
    check(profiles.has(`${e.role}:${e.grade}`), p, 'Unknown current role/grade');
    check(isDate(e.last_review_date) && e.last_review_date <= data.asOf, `${p}.last_review_date`, 'Invalid review date');
    if (e.hire_date != null) check(isDate(e.hire_date) && e.hire_date <= data.asOf, `${p}.hire_date`, 'Invalid hire date');
    check(e.manager_id == null || e.manager_id === '' || sets.employees.has(e.manager_id), `${p}.manager_id`, 'Unknown manager');
    check(e.career_goal == null || (object(e.career_goal) && profiles.has(`${e.career_goal.target_role}:${e.career_goal.target_grade}`)), `${p}.career_goal`, 'Unknown target role/grade');
    skillLevels(e.skills, `${p}.skills`);
  });
  data.events.forEach((e, i) => {
    const p = `events[${i}]`;
    check(typeof e.title === 'string' && e.title.length > 0, `${p}.title`, 'Required title');
    check(typeof e.type === 'string' && e.type.length > 0, `${p}.type`, 'Required type');
    check(['self_paced', 'online', 'offline'].includes(e.format), `${p}.format`, 'Unknown format');
    check(typeof e.mandatory === 'boolean', `${p}.mandatory`, 'Expected boolean');
    check(Number.isFinite(e.duration_hours) && e.duration_hours > 0, `${p}.duration_hours`, 'Must be positive');
    check(Array.isArray(e.target_roles) && e.target_roles.length > 0 && e.target_roles.every(r => data.roleProfiles.some(p => p.role === r)), `${p}.target_roles`, 'Unknown role or missing array');
    check(Array.isArray(e.target_grades) && e.target_grades.length > 0 && e.target_grades.every(g => GRADES.includes(g)), `${p}.target_grades`, 'Unknown grade or missing array');
    skillLevels(e.prerequisites, `${p}.prerequisites`);
    check(Array.isArray(e.upcoming_sessions) && e.upcoming_sessions.every(isDate) && new Set(e.upcoming_sessions).size === e.upcoming_sessions.length, `${p}.upcoming_sessions`, 'Expected unique valid dates');
    check(Array.isArray(e.develops_skills), `${p}.develops_skills`, 'Expected array');
    const seen = new Set();
    for (const [j, gain] of (Array.isArray(e.develops_skills) ? e.develops_skills : []).entries()) {
      check(object(gain) && sets.skills.has(gain.skill_id) && !seen.has(gain.skill_id) && level(gain.gain) && gain.gain > 0 && level(gain.max_level), `${p}.develops_skills[${j}]`, 'Expected unique known skill, positive integer gain and max_level 0–5');
      seen.add(gain?.skill_id);
    }
  });
  data.history.forEach((r, i) => {
    const p = `history[${i}]`;
    check(sets.employees.has(r.employee_id), `${p}.employee_id`, 'Unknown employee');
    check(sets.events.has(r.event_id), `${p}.event_id`, 'Unknown event');
    check(isDate(r.date) && r.date <= data.asOf, `${p}.date`, 'Invalid date or after snapshot');
    check(!r.due_date || (isDate(r.due_date) && r.due_date >= r.date), `${p}.due_date`, 'Invalid due date');
    check(STATUSES.includes(r.status), `${p}.status`, 'Unknown status');
    for (const [field, max] of [['completion_pct', 100], ['score', 100], ['feedback_rating', 5]]) {
      const value = r[field];
      if (value === '' || value == null) { r[field] = null; continue; }
      const n = typeof value === 'string' && value.trim() ? Number(value) : value;
      check(typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max, `${p}.${field}`, `Expected 0–${max}`);
      r[field] = n;
    }
  });
  check(object(rules.pointsByEventType), 'rules.pointsByEventType', 'Expected points map');
  for (const [k, n] of Object.entries(rules.pointsByEventType || {})) check(Number.isInteger(n) && n >= 0, `rules.pointsByEventType.${k}`, 'Expected nonnegative integer');
  check(Number.isInteger(rules.pointsByEventType?.default), 'rules.pointsByEventType.default', 'Default reward required');
  check(Array.isArray(rules.repeatableEventIds) && rules.repeatableEventIds.every(x => sets.events.has(x)), 'rules.repeatableEventIds', 'Unknown event or missing array');
  check(object(rules.sessionPrograms), 'rules.sessionPrograms', 'Expected program map');
  for (const [key, rule] of Object.entries(rules.sessionPrograms || {})) {
    const event = data.events.find(e => e.event_id === key);
    check(Boolean(event) && object(rule) && rule.completionRule === 'all_sessions' && Number.isInteger(rule.pointsPerSession) && rule.pointsPerSession >= 0 && event.upcoming_sessions?.length > 0 && event.develops_skills?.some(g => g.skill_id === rule.skillId) && Array.isArray(rule.sessionLabels) && rule.sessionLabels.length === event.upcoming_sessions.length && rule.sessionLabels.every(x => typeof x === 'string'), `rules.sessionPrograms.${key}`, 'Invalid session program');
    check(!(Array.isArray(rules.repeatableEventIds) && rules.repeatableEventIds.includes(key)), `rules.sessionPrograms.${key}`, 'Multi-session programs are one-time');
  }
  data.history.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.record_id).localeCompare(String(b.record_id)));
  return { valid: errors.length === 0, errors, data, counts: Object.fromEntries(['employees', 'skills', 'events', 'roleProfiles', 'history'].map(k => [k, data[k].length])) };
}

// RFC4180-style quoted cells, including BOM, commas and embedded newlines.
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (c === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift() || [];
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV headers');
  return rows.filter(r => r.some(Boolean)).map(r => {
    if (r.length !== headers.length) throw new Error('CSV row width mismatch');
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  });
}

export function loadDataset(source) {
  if (source.endsWith('.json')) return readJson(source);
  const employees = readJson(resolve(source, 'employees.json'));
  const events = readJson(resolve(source, 'events.json'));
  const skills = readJson(resolve(source, 'skills.json'));
  const dates = [employees, events, skills].map(d => d.meta?.as_of_date);
  if (!dates.every(d => d === dates[0])) throw new Error('Dataset snapshot dates must match');
  return { asOf: dates[0], employees: employees.employees, events: events.events, skills: skills.skills, roleProfiles: skills.role_profiles,
    history: parseCsv(readFileSync(resolve(source, 'activity_history.csv'), 'utf8')) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = validateDataset(loadDataset(process.argv[2] || 'src/prototype/data.json'), readJson('src/prototype/demo-rules.json'));
  console.log(JSON.stringify({ valid: result.valid, counts: result.counts, errors: result.errors }, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}
