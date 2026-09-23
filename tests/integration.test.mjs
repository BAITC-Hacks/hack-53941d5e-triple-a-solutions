import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../src/backend/validate.mjs';
import { buildServer } from '../src/backend/server.mjs';
import { workflowService } from '../src/backend/workflows.mjs';
import { createStructuredProvider, readConfig } from '../scripts/ai/provider.mjs';
import { planProgress } from '../src/prototype/development.mjs';
const dataset = readJson(new URL('../src/prototype/data.json', import.meta.url));
const rules = readJson(new URL('../src/prototype/demo-rules.json', import.meta.url));
const offline = () => createStructuredProvider({ config: readConfig({ AI_ENABLED: 'false' }), fetchImpl: () => assert.fail('No external calls') });
function appFor(t, aiProvider = offline()) {
  const app = buildServer({ dataset, rules, employeeToken: 'test-employee', hrToken: 'test-hr', aiProvider });
  t.after(() => app.store.close()); return app;
}
test('merged HTTP workflows enforce identity, HR role and server-owned state', async t => {
  const app = appFor(t); await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { app.server.closeAllConnections(); app.server.close(r); }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, input, token = 'test-employee') => fetch(url + path, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
  assert.equal((await call('/api/recommendations', { employeeId: 'E0005' })).status, 403);
  assert.equal((await call('/api/recommendations', { employeeId: 'E0066', simulated: ['EV_005'] })).status, 422);
  assert.equal((await call('/api/hr/activity-contexts')).status, 403);
  assert.equal((await call('/api/hr/improve-activity', { eventId: 'EV_005', brief: '' })).status, 403);
  assert.equal((await fetch(url + '/api/development-plan', { method: 'POST' })).status, 401);
  const recs = await (await call('/api/recommendations', { employeeId: 'E0066' })).json();
  assert.deepEqual(recs.recommendations.map(r => r.event_id), app.service.recommendations('E0066').recommendations.map(r => r.event.event_id));
  const plan = await (await call('/api/development-plan', { employeeId: 'E0066', options: { maxSteps: 3 } })).json();
  assert.equal(plan.source, 'rules'); assert.ok(plan.plan.steps.length);
  assert.deepEqual(planProgress(plan.plan, app.service.profile('E0066')), { valid: true, done: 0 });
  assert.equal((await call('/api/development-plan', { employeeId: 'E0066', options: { maxSteps: 99 } })).status, 400);
  const contexts = await (await call('/api/hr/activity-contexts', null, 'test-hr')).json();
  assert.ok(contexts.length); assert.ok(!JSON.stringify(contexts).includes(dataset.employees[0].full_name));
  const draft = await (await call('/api/hr/improve-activity', { eventId: 'EV_005', brief: '' }, 'test-hr')).json();
  assert.equal(draft.source, 'rules'); assert.ok(draft.draft.agenda.length);
  for (const file of ['ai-client.mjs', 'development.mjs', 'workshop-ui.mjs']) assert.equal((await fetch(url + '/' + file)).status, 200);
  assert.equal((await fetch(url + '/data.json')).status, 404);
});
test('AI cannot reorder backend recommendations, invent a path or alter levels', async t => {
  let mode = 'valid', calls = 0;
  const provider = createStructuredProvider({ config: readConfig({ OPENAI_API_KEY: 'synthetic-test-only' }), fetchImpl: async (_url, options) => {
    calls++; const input = JSON.parse(options.body), payload = JSON.parse(input.input);
    assert.ok(!JSON.stringify(payload).includes('E0066'));
    assert.ok(dataset.employees.every(e => !JSON.stringify(payload).includes(e.full_name)));
    let answer;
    if (input.text.format.name === 'career_recommendations') {
      answer = { recommendations: payload.candidates.map(c => ({ event_id: c.event_id, reason: 'Test explanation', evidence_ids: c.evidence.filter(e => ['goal', 'skill', 'history'].includes(e.category)).map(e => e.id) })) };
      if (mode === 'reorder') answer.recommendations.reverse();
    } else {
      assert.equal(payload.paths.length, 1);
      const path = payload.paths[0]; answer = { path_id: mode === 'invent' ? 'fake' : path.path_id, title: 'Test', summary: 'Test', steps: path.steps.map(s => ({ event_id: s.event_id, reason: 'Test' })) };
    }
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }));
  } });
  const app = appFor(t, provider), service = app.service, before = service.profile('E0066');
  const workflow = () => workflowService(service, provider);
  assert.equal((await workflow().recommendations('E0066')).source, 'ai');
  // Different state changes the cache key while retaining several candidates.
  mode = 'reorder'; service.setGoal('E0066', { role: 'QA Engineer', grade: 'Lead' });
  const result = await workflow().recommendations('E0066');
  assert.equal(result.source, 'rules');
  assert.deepEqual(result.recommendations.map(r => r.event_id), service.recommendations('E0066').recommendations.map(r => r.event.event_id));
  mode = 'invent'; assert.equal((await workflow().developmentPlan('E0066', { maxSteps: 2 })).source, 'rules');
  assert.deepEqual(service.profile('E0066').levels, before.levels); assert.equal(service.profile('E0066').totalPoints, before.totalPoints); assert.ok(calls >= 3);
});
test('new projections use persisted levels and completion history without awarding progress', async t => {
  const app = appFor(t), service = app.service;
  const item = service.catalog('E0066').find(c => c.canComplete && !c.program);
  assert.ok(item); service.complete('E0066', item.event.event_id, item.completionSessionId, 'integration-completion');
  const before = service.profile('E0066');
  const result = await workflowService(service, offline()).developmentPlan('E0066', { maxSteps: 4 });
  if (result.plan) {
    assert.equal(result.plan.coverageBefore, before.coverage);
    assert.ok(!result.plan.steps.some(s => s.event_id === item.event.event_id));
    for (const skill of result.plan.statChanges) assert.equal(skill.before, before.levels[skill.id] || 0);
  }
  assert.deepEqual(service.profile('E0066'), before);
});

test('multi-session plans start at the first outstanding session and finish after the last', async t => {
  const app = appFor(t), service = app.service;
  const event = dataset.events.find(e => e.event_id === 'EV_019');
  const result = await workflowService(service, offline()).developmentPlan('E0066', { maxSteps: 1, focusSkill: event.develops_skills[0].skill_id });
  assert.ok(result.plan);
  const step = result.plan.steps.find(s => s.event_id === 'EV_019');
  assert.ok(step); assert.equal(step.start, [...event.upcoming_sessions].sort()[0]);
  assert.ok(step.end >= [...event.upcoming_sessions].sort().at(-1));
});

test('HR preview/commit/undo share persistent SQLite and refuse to erase employee actions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cq-merged-import-'));
  const options = { dataset, rules, employeeToken: 'test-employee', hrToken: 'test-hr', aiProvider: offline(), dbPath: join(directory, 'test.sqlite') };
  let app = buildServer(options);
  async function start() { await new Promise(r => app.server.listen(0, '127.0.0.1', r)); }
  async function stop() { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); app.store.close(); }
  await start(); t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path, input, token = 'test-hr') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const profile = { ...dataset.employees[0], employee_id: 'SYNC_SYNTHETIC', full_name: 'Synthetic Import', manager_id: null };
  const files = [{ kind: 'employees', text: JSON.stringify([profile]) }];
  assert.equal((await request('/api/dataset', null, 'test-employee')).status, 403);
  const initial = (await request('/api/dataset')).body;
  assert.equal((await request('/api/import/preview', { version: initial.version, files }, 'test-employee')).status, 403);
  const preview = (await request('/api/import/preview', { version: initial.version, files })).body;
  assert.equal(preview.ok, true, JSON.stringify(preview.errors)); assert.ok(preview.token);
  assert.equal(app.service.data.employees.length, dataset.employees.length);
  const committed = await request('/api/import/commit', { version: preview.version, token: preview.token });
  assert.equal(committed.status, 200); assert.equal(committed.body.data.employees.length, dataset.employees.length + 1);
  assert.equal((await request('/api/hr/employees/SYNC_SYNTHETIC')).status, 200);
  assert.equal((await request('/api/import/commit', { version: preview.version, token: preview.token })).status, 409);
  assert.equal((await request('/api/development-plan', { employeeId: 'E0066', datasetVersion: initial.version }, 'test-employee')).status, 409);
  await stop(); app = buildServer(options); await start();
  assert.equal(app.service.data.employees.length, dataset.employees.length + 1);
  const undone = await request('/api/import/undo', { version: committed.body.version });
  assert.equal(undone.status, 200); assert.equal(undone.body.version, initial.version);
  const again = (await request('/api/import/preview', { version: initial.version, files })).body;
  const item = app.service.catalog('E0066').find(c => c.canComplete && !c.program);
  app.service.complete('E0066', item.event.event_id, item.completionSessionId, 'protect-progress');
  const before = app.service.profile('E0066');
  assert.equal((await request('/api/import/commit', { version: again.version, token: again.token })).status, 409);
  assert.deepEqual(app.service.profile('E0066'), before);
});
