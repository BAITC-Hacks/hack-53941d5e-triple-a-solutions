import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/backend/store.mjs';
import { CareerService } from '../src/backend/service.mjs';
import { buildServer } from '../src/backend/server.mjs';
import { validateDataset, readJson, parseCsv } from '../src/backend/validate.mjs';

function fixture() {
  const employee = { employee_id: 'E1', full_name: 'Synthetic One', department: 'Demo', role: 'Engineer', grade: 'Junior', manager_id: null,
    last_review_date: '2026-09-01', skills: { A: 1, B: 4 }, career_goal: { target_role: 'Engineer', target_grade: 'Middle' } };
  const base = { title: 'Synthetic activity', description: 'Test fixture', type: 'course', format: 'self_paced', duration_hours: 2, mandatory: false,
    target_roles: ['Engineer'], target_grades: ['Junior'], prerequisites: {}, upcoming_sessions: [], develops_skills: [{ skill_id: 'A', gain: 1, max_level: 3 }] };
  const events = [
    { ...base, event_id: 'COURSE' },
    { ...base, event_id: 'PROGRAM', format: 'online', upcoming_sessions: ['2026-09-29', '2026-09-30', '2026-10-01'] },
    { ...base, event_id: 'CLUB', type: 'meetup', format: 'offline', upcoming_sessions: ['2026-09-30', '2026-10-01', '2026-10-08'] },
    { ...base, event_id: 'CAP', develops_skills: [{ skill_id: 'B', gain: 1, max_level: 2 }] },
    { ...base, event_id: 'LOCKED', prerequisites: { A: 5 } },
    { ...base, event_id: 'FUTURE', format: 'online', upcoming_sessions: ['2026-10-08'] },
  ];
  const data = { asOf: '2026-10-01', employees: [employee, { ...employee, employee_id: 'E2', full_name: 'Synthetic Two', career_goal: null }],
    skills: [{ skill_id: 'A', name: 'Skill A' }, { skill_id: 'B', name: 'Skill B' }],
    roleProfiles: [ { role: 'Engineer', grade: 'Junior', required_skills: { A: 1 }, critical_skills: [] },
      { role: 'Engineer', grade: 'Middle', required_skills: { A: 3, B: 4 }, critical_skills: ['A'] } ], events,
    history: [{ record_id: 'R1', employee_id: 'E1', event_id: 'COURSE', date: '2026-09-20', due_date: '', status: 'no_show', completion_pct: '0', score: '', feedback_rating: '' }] };
  const rules = { pointsByEventType: { course: 4, meetup: 1, default: 2 }, repeatableEventIds: ['CLUB'], sessionPrograms: {
    PROGRAM: { skillId: 'A', pointsPerSession: 1, completionRule: 'all_sessions', sessionLabels: ['One', 'Two', 'Three'] } } };
  return { data, rules };
}
function service(t, input = fixture()) {
  const store = new Store(':memory:', input.data, input.rules); t.after(() => store.close()); return new CareerService(store);
}
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

 test('full synthetic dataset validates; CSV numeric fields normalize and malformed references reject', () => {
  const result = validateDataset(readJson('src/prototype/data.json'), readJson('src/prototype/demo-rules.json'));
  assert.equal(result.valid, true, JSON.stringify(result.errors)); assert.equal(result.counts.employees, 200);
  assert.equal(typeof result.data.history[0].completion_pct, 'number');
  const { data, rules } = fixture(); data.events[0].develops_skills[0].skill_id = 'UNKNOWN';
  assert.equal(validateDataset(data, rules).valid, false);
  assert.deepEqual(parseCsv('\ufeffa,b\r\n"hello, world","line\nnext"\r\n'), [{ a: 'hello, world', b: 'line\nnext' }]);
  assert.throws(() => parseCsv('a,b\n"unclosed'));
});

test('recommendations are deterministic, explained, capped at three and obey eligibility', t => {
  const s = service(t); const first = s.recommendations('E1');
  assert.deepEqual(first, s.recommendations('E1')); assert.equal(first.recommendations.length, 3);
  assert.ok(first.recommendations.every(r => r.impact.length && r.explanation && r.event.event_id !== 'LOCKED' && r.event.event_id !== 'CAP'));
  const r = first.recommendations.find(r => r.event.type === 'course');
  assert.equal(r.impact[0].after, 2); assert.equal(r.coverageAfter, 86); // (2+4)/(3+4)
  assert.equal(r.historyBreakdown.no_show, 0); // The selected online course has no format-matched no-shows.
  assert.ok(!first.recommendations.some(r => r.event.event_id === 'COURSE')); // Lower priority after a self-paced no-show.
});

test('program awards each explicit session once, gains only after all three', t => {
  const s = service(t), before = s.profile('E1');
  for (const [i, date] of ['2026-09-29', '2026-09-30', '2026-10-01'].entries()) {
    const session = `PROGRAM:${date}`, key = `program-key-${i}`;
    const result = s.complete('E1', 'PROGRAM', session, key);
    assert.equal(result.totalPoints, i + 1); assert.equal(result.finished, i === 2);
    assert.equal(result.profile.levels.A, i === 2 ? before.levels.A + 1 : before.levels.A);
    assert.deepEqual(s.complete('E1', 'PROGRAM', session, key), result);
    throwsCode(() => s.complete('E1', 'PROGRAM', session, `different-${i}`), 'ALREADY_COMPLETED');
  }
  assert.equal(s.profile('E1').coverage, 86);
});

test('single course, ceilings, denied and future sessions, idempotency conflicts', t => {
  const s = service(t);
  const done = s.complete('E1', 'COURSE', undefined, 'course-key');
  assert.equal(done.pointsAwarded, 4); assert.equal(done.profile.levels.A, 2);
  throwsCode(() => s.complete('E1', 'COURSE', undefined, 'other-key'), 'ALREADY_COMPLETED');
  throwsCode(() => s.complete('E1', 'CAP', undefined, 'course-key'), 'IDEMPOTENCY_CONFLICT');
  const capped = s.complete('E1', 'CAP', undefined, 'cap-key-1'); assert.equal(capped.profile.levels.B, 4);
  throwsCode(() => s.complete('E1', 'LOCKED', undefined, 'locked-key'), 'NOT_ELIGIBLE');
  throwsCode(() => s.complete('E1', 'FUTURE', 'FUTURE:2026-10-08', 'future-key'), 'FUTURE_SESSION');
  throwsCode(() => s.complete('E1', 'CLUB', undefined, 'club-key-1'), 'INVALID_SESSION');
});

test('repeatable club requires distinct sessions and never double awards', t => {
  const s = service(t);
  s.complete('E1', 'CLUB', 'CLUB:2026-09-30', 'club-first');
  throwsCode(() => s.complete('E1', 'CLUB', 'CLUB:2026-09-30', 'club-again'), 'ALREADY_COMPLETED');
  s.complete('E1', 'CLUB', 'CLUB:2026-10-01', 'club-next');
  assert.equal(s.profile('E1').totalPoints, 2); assert.equal(s.profile('E1').levels.A, 3);
});

test('important no-shows warn without reducing skills or points; completed goals return no recommendations', t => {
  const s = service(t), profile = s.profile('E1');
  assert.equal(profile.warnings[0].code, 'MISSED_GOAL_SKILL'); assert.equal(profile.levels.A, 1); assert.equal(profile.totalPoints, 0);
  s.setGoal('E1', { role: 'Engineer', grade: 'Junior' });
  assert.equal(s.profile('E1').warnings.length, 0); assert.deepEqual(s.recommendations('E1').recommendations, []);
  assert.equal(s.recommendations('E1').emptyReason, 'GOAL_REQUIREMENTS_MET');
  throwsCode(() => s.setGoal('E1', { role: 'Invented', grade: 'Lead' }), 'INVALID_GOAL');
  const hr = s.overview(); assert.equal(hr.totalMisses, 1); assert.equal(hr.noGoal, 1); assert.equal('pointsRanking' in hr, false);
});

test('historical one-time duplicate does not double gain, history retained', t => {
  const f = fixture(); f.data.history = ['2026-09-20', '2026-09-21'].map((date, i) => ({ record_id: `R${i}`, employee_id: 'E1', event_id: 'COURSE', date, status: 'completed', completion_pct: 100 }));
  const s = service(t, f); assert.equal(s.profile('E1').levels.A, 2); assert.equal(s.profile('E1').history.length, 2); assert.equal(s.profile('E1').totalPoints, 4);
});

test('restart preserves goals, points, levels and idempotent responses', () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-quest-')), file = join(directory, 'test.sqlite'), f = fixture();
  let store;
  try {
    store = new Store(file, f.data, f.rules); let s = new CareerService(store);
    const result = s.complete('E1', 'COURSE', undefined, 'persist-key');
    s.setGoal('E1', { role: 'Engineer', grade: 'Junior' }); store.close(); store = undefined;
    store = new Store(file, f.data, f.rules); s = new CareerService(store);
    assert.equal(s.profile('E1').goal.grade, 'Junior'); assert.equal(s.profile('E1').levels.A, 2); assert.equal(s.profile('E1').totalPoints, 4);
    assert.deepEqual(s.complete('E1', 'COURSE', undefined, 'persist-key'), result);
  } finally { store?.close(); rmSync(directory, { recursive: true }); }
});

test('HTTP auth, private data boundaries, concurrent requests and import safety', async t => {
  const f = fixture(); const app = buildServer({ dataset: f.data, rules: f.rules, employeeId: 'E1', employeeToken: 'employee-test-key', hrToken: 'hr-test-key' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, token = 'employee-test-key', method = 'GET', data, extra = {}) => fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.equal((await request('/api/employees/E1', null)).status, 401);
  assert.equal((await request('/api/hr/overview')).status, 403);
  assert.equal((await request('/api/employees/E2')).status, 403);
  assert.equal((await request('/api/employees/E2', 'hr-test-key')).status, 403);
  assert.equal((await request('/api/hr/employees/E2', 'hr-test-key')).status, 200);
  for (const path of ['/data.json', '/demo-rules.json', '/.local/access.json', '/src/backend/server.mjs']) assert.equal((await request(path)).status, 404);
  const bootstrap = await (await request('/api/bootstrap')).json(); assert.equal(bootstrap.employees.length, 1); assert.equal('history' in bootstrap, false);
  assert.equal((await request('/api/employees/E1/goal', 'employee-test-key', 'PUT', { role: 'Engineer', grade: 'Middle' }, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await request('/api/dataset/validate', 'hr-test-key', 'POST', { dataset: { broken: true } })).status, 422);
  assert.equal((await request('/api/dataset/import', 'hr-test-key', 'POST', { dataset: f.data })).status, 200);
  const responses = await Promise.all(Array.from({ length: 5 }, () => request('/api/employees/E1/events/COURSE/complete', 'employee-test-key', 'POST', {}, { 'Idempotency-Key': 'concurrent-key' })));
  const results = await Promise.all(responses.map(r => r.json())); assert.ok(responses.every(r => r.status === 200));
  assert.ok(results.every(r => r.completion.id === results[0].completion.id)); assert.equal(app.service.profile('E1').totalPoints, 4);
  const f2 = fixture(); f2.data.employees[0].full_name = 'Synthetic Changed';
  assert.equal((await request('/api/dataset/import', 'hr-test-key', 'POST', { dataset: f2.data })).status, 409);
  const hr = await (await request('/api/hr/overview', 'hr-test-key')).json(); assert.equal(hr.participation.completed, 1); assert.equal(hr.activityCount, 1);
  const login = await request('/api/auth/session', null, 'POST', { token: 'employee-test-key' }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie'); assert.ok(cookie.includes('HttpOnly')); assert.ok(cookie.includes('SameSite=Strict'));
  const withCookie = await fetch(base + '/api/bootstrap', { headers: { Cookie: cookie.split(';')[0] } }); assert.equal(withCookie.status, 200);
});

test('backend invariants hold for every employee in the supplied dataset', t => {
  const s = service(t, { data: readJson('src/prototype/data.json'), rules: readJson('src/prototype/demo-rules.json') });
  const ctx = s.context();
  for (const e of s.data.employees) {
    const state = s.profile(e.employee_id, ctx);
    assert.ok(state.coverage >= 0 && state.coverage <= 100);
    for (const [skill, level] of Object.entries(e.skills)) assert.ok(state.levels[skill] >= level && state.levels[skill] <= 5);
    const recs = s.recommendations(e.employee_id, ctx, state).recommendations;
    assert.ok(recs.length <= 3);
    for (const r of recs) {
      assert.ok(r.event.target_roles.includes(e.role) && r.event.target_grades.includes(e.grade));
      assert.ok(r.event.format === 'self_paced' || r.session >= s.asOf);
      assert.ok(r.impact.every(i => i.after >= i.level && i.reduction > 0));
      assert.ok(Object.entries(r.event.prerequisites).every(([id, level]) => state.levels[id] >= level));
      assert.ok(!state.done.includes(r.event.event_id) || r.repeatAllowed);
    }
  }
});

test('different concurrent keys cannot double-complete one course', async t => {
  const f = fixture(), app = buildServer({ dataset: f.data, rules: f.rules, employeeId: 'E1', employeeToken: 'employee-test-key', hrToken: 'hr-test-key' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const url = `http://127.0.0.1:${app.server.address().port}/api/employees/E1/events/COURSE/complete`;
  const results = await Promise.all(['distinct-1', 'distinct-2'].map(key => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer employee-test-key', 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: '{}' })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(app.service.profile('E1').totalPoints, 4);
});

test('invalid nested data reports errors instead of throwing; invalid import leaves state intact', t => {
  const cases = [
    f => { f.data.events[0].develops_skills = [null]; },
    f => { f.rules.repeatableEventIds = 42; },
    f => { f.rules.sessionPrograms.PROGRAM = null; },
    f => { f.data.employees[0].skills = { A: 6 }; },
    f => { f.data.history[0].date = '2026-02-30'; },
    f => { f.data.history[0].score = 'not a number'; },
    f => { f.data.events[0].upcoming_sessions = ['2026-10-01', '2026-10-01']; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.equal(validateDataset(f.data, f.rules).valid, false); }
  const s = service(t); const before = s.profile('E1');
  throwsCode(() => s.complete('E1', 'FUTURE', 'FUTURE:2026-10-08', 'invalid-date-key'), 'FUTURE_SESSION');
  assert.deepEqual(s.profile('E1'), before);
});
