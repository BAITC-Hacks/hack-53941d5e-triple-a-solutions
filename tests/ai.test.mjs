import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContext, validateAnswer, createRecommender, configurationStatus } from '../scripts/ai/recommender.mjs';
import { createAppServer } from '../scripts/serve.mjs';
import { createModel } from '../src/prototype/model.mjs';
import { createAiClient, requestFor } from '../src/prototype/ai-client.mjs';

const data = JSON.parse(readFileSync(new URL('../src/prototype/data.json', import.meta.url)));
const context = buildContext(data, { employeeId: 'E0005' });
const config = { enabled: true, dataApproved: true, model: 'test-model', key: 'test-key', baseUrl: 'https://example.invalid/v1', timeoutMs: 100 };
const answerFor = (ctx = context, index = 0) => {
  const id = ctx.candidates[index].event.event_id;
  return { recommendations: [{ event_id: id, reason: 'Тест транспорта: объяснение не сгенерировано реальной моделью.',
    evidence_ids: ctx.payload.candidates.find(item => item.event_id === id).evidence.filter(fact => ['goal', 'skill', 'history'].includes(fact.category)).map(fact => fact.id) }] };
};
const responseFor = answer => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }), { status: 200 });

test('server reconstructs browser baseline for all profiles without sending names or IDs to provider', () => {
  const model = createModel(data);
  for (const employee of data.employees) {
    const ctx = buildContext(data, { employeeId: employee.employee_id });
    assert.deepEqual(ctx.candidates.map(r => r.event.event_id), model.recommend(employee).map(r => r.event.event_id));
    assert.ok(!JSON.stringify(ctx.payload).includes(employee.full_name));
    assert.equal(ctx.payload.employee.employee_id, undefined);
    assert.equal(ctx.payload.employee.skills, undefined);
  }
});

test('simulation and a changed goal use the exact browser state and do not mutate source data', () => {
  const source = JSON.stringify(data);
  const model = createModel(data);
  const person = data.employees.find(p => p.employee_id === 'E0005');
  const event = model.recommend(person)[0].event.event_id;
  model.complete(person.employee_id, event);
  model.setGoal(person.employee_id, 'Data Analyst', 'Middle');
  const state = model.snapshot(person);
  const ctx = buildContext(data, requestFor(state));
  assert.deepEqual(ctx.state.levels, state.levels);
  assert.deepEqual(ctx.candidates, model.recommend(person));
  assert.equal(JSON.stringify(data), source);
  assert.throws(() => buildContext(data, { employeeId: person.employee_id, simulated: [event, event] }));
  assert.throws(() => buildContext(data, { employeeId: person.employee_id, simulated: ['EV_001'] }));
  assert.throws(() => buildContext(data, { employeeId: 'unknown' }));
  assert.throws(() => buildContext(data, { employeeId: person.employee_id, goal: { role: 'made-up', grade: 'Lead' } }));
});

test('provider output must cite three factors for the selected eligible event', () => {
  assert.equal(validateAnswer(answerFor(), context).length, 1);
  const unknown = answerFor(); unknown.recommendations[0].event_id = 'EV_001';
  assert.throws(() => validateAnswer(unknown, context));
  const missing = answerFor(); missing.recommendations[0].evidence_ids = missing.recommendations[0].evidence_ids.filter(id => !id.endsWith(':history'));
  assert.throws(() => validateAnswer(missing, context));
  const foreign = answerFor(); foreign.recommendations[0].evidence_ids[0] = 'another-event:goal';
  assert.throws(() => validateAnswer(foreign, context));
  const duplicate = answerFor(); duplicate.recommendations.push(duplicate.recommendations[0]);
  assert.throws(() => validateAnswer(duplicate, context));
  assert.throws(() => validateAnswer({ recommendations: [] }, context));
});

test('disabled or unapproved AI never calls provider; localhost may work without a key', async () => {
  for (const options of [{ enabled: false }, { dataApproved: false }, { model: '' }, { baseUrl: 'http://remote.example/v1' }]) {
    const service = createRecommender({ config: { ...config, ...options }, fetchImpl: () => { assert.fail('unexpected external call'); } });
    const result = await service.run(context);
    assert.equal(result.source, 'rules');
    assert.equal(result.recommendations[0].event_id, context.candidates[0].event.event_id);
  }
  assert.equal(configurationStatus({ ...config, key: '', baseUrl: 'http://127.0.0.1:8000/v1' }).ready, true);
  assert.equal(configurationStatus({ ...config, key: '', baseUrl: 'https://api.openai.com/v1' }).ready, false);
});

test('Responses request uses strict schema, server credentials, store:false and state-specific cache', async () => {
  let calls = 0;
  const service = createRecommender({ config, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.invalid/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    return responseFor(answerFor());
  } });
  const [first, second] = await Promise.all([service.run(context), service.run(context)]);
  assert.equal(first.source, 'ai');
  assert.equal(second.source, 'ai');
  assert.equal(calls, 1);
  assert.equal((await service.run(context)).cached, true);
});

test('refusal, bad facts, HTTP error and timeout fall back without exposing provider errors or keys', async () => {
  const transports = [
    async () => new Response('secret provider detail test-key', { status: 401 }),
    async () => responseFor({ recommendations: [{ event_id: 'fabricated' }] }),
    async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'refusal' }] }] })),
    (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  ];
  for (const fetchImpl of transports) {
    const result = await createRecommender({ config, fetchImpl }).run(context);
    assert.equal(result.source, 'rules');
    assert.ok(!JSON.stringify(result).includes('test-key'));
  }
});

test('browser associates late replies with their state and reset discards pending results', async () => {
  const releases = [];
  const client = createAiClient(() => new Promise(resolve => releases.push(resolve)));
  const model = createModel(data);
  const a = model.snapshot(data.employees[0]);
  const b = model.snapshot(data.employees[1]);
  const pending = client.request(a);
  assert.equal(client.get(a).status, 'loading');
  assert.equal(client.get(b).status, 'idle');
  client.reset();
  releases[0](new Response(JSON.stringify({ source: 'ai', recommendations: [{ event_id: 'test' }] })));
  await pending;
  assert.equal(client.get(a).status, 'idle');
});

test('HTTP server serves only allowlisted assets and rejects cross-origin or invalid API requests', async t => {
  const service = createRecommender({ config: { ...config, enabled: false } });
  const server = createAppServer({ data, recommender: service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/`)).status, 200);
  assert.equal((await fetch(`${url}/.env.local`)).status, 404);
  assert.equal((await fetch(`${url}/scripts/ai/system-prompt.txt`)).status, 404);
  assert.equal((await fetch(`${url}/api/ai/status`)).status, 200);
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: 'E0005' }) };
  const reply = await (await fetch(`${url}/api/recommendations`, options)).json();
  assert.equal(reply.source, 'rules');
  assert.equal((await fetch(`${url}/api/recommendations`, { ...options, headers: { ...options.headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(`${url}/api/recommendations`, { ...options, body: '{}' })).status, 400);
});
