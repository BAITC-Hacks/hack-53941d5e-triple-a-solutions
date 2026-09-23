import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareImport, parseCsv } from '../scripts/import-data.mjs';
import { createDatasetStore } from '../scripts/dataset-store.mjs';
import { createAppServer } from '../scripts/serve.mjs';
import { createStructuredProvider, readConfig } from '../scripts/ai/provider.mjs';
import { createRecommender } from '../scripts/ai/recommender.mjs';
import { createWorkflows } from '../scripts/ai/workflows.mjs';
import { activityContext } from '../src/prototype/development.mjs';

const base = JSON.parse(readFileSync(new URL('../src/prototype/data.json', import.meta.url)));
const employee = { employee_id: 'JURY_TEST', full_name: 'Invented Test', role: 'Backend Engineer', grade: 'Junior',
  skills: { SK_PYTHON: 2, SK_SYSTEM_DESIGN: 1 }, career_goal: { target_role: 'Backend Engineer', target_grade: 'Middle' }, last_review_date: base.asOf };
const history = 'record_id,employee_id,event_id,date,status\r\nJURY_RECORD,JURY_TEST,EV_005,2026-09-20,no_show\r\n';
const files = () => [{ kind: 'employees', name: 'employees.json', text: JSON.stringify([employee]) }, { kind: 'history', name: 'history.csv', text: history }];

test('CSV parses BOM, CRLF, quoted commas, quotes and multiline fields; rejects malformed input', () => {
  const rows = parseCsv('\uFEFFrecord_id,employee_id,event_id,date,status,assigned_by\r\nR1,E1,EV1,2026-09-01,completed,"name, ""quoted""\nnext line"\r\n');
  assert.equal(rows[0].assigned_by, 'name, "quoted"\nnext line');
  for (const text of ['a,a\n1,2', 'record_id,employee_id,event_id,date,status\n1,2', 'record_id,employee_id,event_id,date,status\n"unclosed', 'record_id,employee_id,event_id,date,status\n"x"tail,E,V,2026-01-01,completed']) assert.throws(() => parseCsv(text));
});

test('profile/history import is atomic, validates references, and is idempotent', () => {
  const before = JSON.stringify(base), result = prepareImport(base, { files: files() });
  assert.equal(result.ok, true, result.errors.join());
  assert.deepEqual(result.summary.employees, { added: 1, replaced: 0, skipped: 0 });
  assert.equal(result.data.history.length, base.history.length + 1);
  const repeat = prepareImport(result.data, { files: files() });
  assert.equal(repeat.ok, true); assert.equal(repeat.changes.length, 0); assert.equal(repeat.summary.history.skipped, 1);
  const invalid = files(); invalid[1].text = history.replace('EV_005', 'UNKNOWN');
  const failed = prepareImport(base, { files: invalid });
  assert.equal(failed.ok, false); assert.equal(failed.data, null);
  assert.equal(JSON.stringify(base), before);
});

test('import rejects invalid skills, dates, duplicate IDs, goals, roles and malformed histories', () => {
  for (const changes of [{ skills: { UNKNOWN: 2 } }, { skills: { SK_PYTHON: 6 } }, { skills: { SK_PYTHON: '2' } },
    { last_review_date: '2026-02-30' }, { last_review_date: '2027-01-01' }, { full_name: {} },
    { role: 'Unknown' }, { career_goal: { target_role: 'Unknown', target_grade: 'Senior' } }, { employee_id: '<script>' }, { employee_id: '__proto__' }]) {
    const result = prepareImport(base, { files: [{ kind: 'employees', text: JSON.stringify([{ ...employee, ...changes }]) }] });
    assert.equal(result.ok, false, JSON.stringify(changes));
  }
  assert.equal(prepareImport(base, { files: [{ kind: 'employees', text: JSON.stringify([employee, employee]) }] }).ok, false);
  for (const bad of [history.replace('no_show', 'passed'), history.replace('2026-09-20', '2027-09-20'), history.replace('JURY_TEST', 'MISSING')]) {
    const f = files(); f[1].text = bad; assert.equal(prepareImport(base, { files: f }).ok, false);
  }
  assert.throws(() => prepareImport(base, { files: [{ kind: 'employees', text: ' '.repeat(5_000_001) }] }));
});

test('conflicts require explicit replacement and preserve history', () => {
  const source = prepareImport(base, { files: files() }).data;
  const f = [{ kind: 'employees', text: JSON.stringify([{ ...employee, full_name: 'Changed invented name' }]) }];
  assert.equal(prepareImport(source, { files: f }).ok, false);
  const changed = prepareImport(source, { files: f, replace: true });
  assert.equal(changed.ok, true); assert.equal(changed.summary.employees.replaced, 1);
  assert.deepEqual(changed.data.history, source.history);
  const identical = prepareImport(base, { files: [{ kind: 'employees', text: JSON.stringify(base.employees[0]) }] });
  assert.equal(identical.summary.employees.skipped, 1);
});

test('preview does not mutate; commit is versioned, persists, and can be undone after restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'career-import-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'import.json'), store = createDatasetStore(base, file), initial = store.snapshot();
  const review = store.preview({ version: initial.version, files: files() });
  assert.equal(store.snapshot().version, initial.version); assert.ok(review.token);
  assert.throws(() => store.commit({ version: 'stale', token: review.token }), /изменились/);
  const next = store.commit(review);
  assert.notEqual(next.version, initial.version); assert.equal(next.canUndo, true);
  assert.throws(() => store.commit(review));
  const reloaded = createDatasetStore(base, file);
  assert.equal(reloaded.snapshot().version, next.version);
  const undone = reloaded.undo({ version: next.version });
  assert.equal(undone.version, initial.version); assert.equal(undone.canUndo, false); assert.equal(undone.imported, false);
  assert.equal(createDatasetStore(base, file).snapshot().version, initial.version);
  assert.throws(() => createDatasetStore({ ...base, asOf: '2026-10-02' }, file), /Исходный набор изменился/);
});

test('server and browser share imported data for all three workflows, reject stale versions, and keep imports private', async t => {
  const store = createDatasetStore(base), provider = createStructuredProvider({ config: readConfig({ AI_ENABLED: 'false' }) });
  const recommender = createRecommender({ provider }), workflows = createWorkflows({ data: () => store.snapshot().data, provider });
  const server = createAppServer({ data: base, datasetStore: store, recommender, workflows });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, input, extra = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(input) });
  const initial = await (await fetch(url + '/api/dataset')).json();
  const review = await (await post('/api/import/preview', { version: initial.version, files: files() })).json();
  const next = await (await post('/api/import/commit', review)).json();
  assert.equal(next.data.employees.at(-1).employee_id, employee.employee_id);
  assert.equal((await (await fetch(url + '/data.json')).json()).employees.at(-1).employee_id, employee.employee_id);
  for (const path of ['/api/recommendations', '/api/development-plan']) {
    const response = await post(path, { employeeId: employee.employee_id, datasetVersion: next.version });
    assert.equal(response.status, 200); assert.equal((await response.json()).source, 'rules');
    assert.equal((await post(path, { employeeId: employee.employee_id, datasetVersion: initial.version })).status, 409);
  }
  const hr = await (await post('/api/hr/improve-activity', { eventId: 'EV_005', brief: 'Practice', datasetVersion: next.version })).json();
  assert.deepEqual(hr.stats, activityContext(next.data, 'EV_005').stats);
  assert.equal((await fetch(url + '/artifacts/imported-dataset.json')).status, 404);
  assert.equal((await post('/api/import/undo', { version: next.version }, { Origin: 'https://example.org' })).status, 403);
  assert.equal((await post('/api/import/commit', review)).status, 409);
  const undone = await (await post('/api/import/undo', { version: next.version })).json(); assert.equal(undone.version, initial.version);
});
