import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyGain, createModel } from '../src/prototype/model.mjs';

const data = JSON.parse(readFileSync(new URL('../src/prototype/data.json', import.meta.url)));

test('recommendations respect real dataset eligibility and remain deterministic for every employee', () => {
  const model = createModel(data);
  for (const employee of data.employees) {
    const state = model.snapshot(employee);
    const recommendations = model.recommend(employee);
    assert.deepEqual(recommendations, model.recommend(employee));
    for (const { event, impact, session } of recommendations) {
      assert.equal(event.mandatory, false);
      assert.ok(event.target_roles.includes(employee.role));
      assert.ok(event.target_grades.includes(employee.grade));
      assert.ok(event.event_id === 'EV_036' || !state.done.has(event.event_id));
      assert.ok(event.format === 'self_paced' || session >= data.asOf);
      for (const [id, minimum] of Object.entries(event.prerequisites)) assert.ok((state.levels[id] || 0) >= minimum);
      assert.ok(impact.every(skill => skill.reduction > 0 && skill.after >= skill.level));
    }
  }
});

test('completion updates actual skill levels once, leaves source untouched, and reset restores state', () => {
  const model = createModel(data);
  const employee = data.employees.find(row => row.employee_id === 'E0005');
  const source = JSON.stringify(data);
  const before = model.snapshot(employee);
  const recommendation = model.recommend(employee)[0];
  assert.ok(recommendation);
  assert.equal(model.complete(employee.employee_id, recommendation.event.event_id), true);
  const after = model.snapshot(employee);
  assert.ok(after.coverage >= before.coverage);
  assert.ok(recommendation.impact.every(skill => after.levels[skill.id] === skill.after));
  assert.equal(model.complete(employee.employee_id, recommendation.event.event_id), false);
  assert.deepEqual(model.snapshot(employee), after);
  assert.equal(JSON.stringify(data), source);
  model.reset();
  assert.deepEqual(model.snapshot(employee), before);
});

test('goals preserve career switches and flag missing goals; changing goal uses the selected requirements', () => {
  const model = createModel(data);
  const switched = data.employees.find(row => row.career_goal && row.career_goal.target_role !== row.role);
  assert.equal(model.snapshot(switched).goal.role, switched.career_goal.target_role);
  const noGoal = data.employees.find(row => !row.career_goal);
  assert.equal(model.snapshot(noGoal).goal.assumed, true);
  assert.equal(model.setGoal(noGoal.employee_id, 'Data Analyst', 'Middle'), true);
  const state = model.snapshot(noGoal);
  assert.equal(state.goal.assumed, false);
  assert.equal(state.goal.role, 'Data Analyst');
  const target = data.roleProfiles.find(row => row.role === 'Data Analyst' && row.grade === 'Middle');
  assert.equal(state.requirements.length, Object.keys(target.required_skills).length);
  assert.equal(model.setGoal(noGoal.employee_id, 'Unknown', 'Middle'), false);
});

test('a capped course cannot lower an existing skill level or raise it past the cap', () => {
  assert.equal(applyGain(4, 1, 3), 4);
  assert.equal(applyGain(2, 2, 3), 3);
  assert.equal(applyGain(5, 1, 5), 5);
});
