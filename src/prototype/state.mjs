import { createModel } from './model.mjs';

// Reconstruct demo state from IDs, never from client-supplied levels or HR aggregates.
export function modelFromProgress(data, progress = []) {
  if (!Array.isArray(progress) || progress.length > data.employees.length) throw new Error('Некорректное состояние демо.');
  const model = createModel(data), seen = new Set();
  for (const row of progress) {
    const person = data.employees.find(p => p.employee_id === row?.employeeId);
    if (!person || seen.has(row.employeeId)) throw new Error('Неизвестный или повторный сотрудник в состоянии демо.');
    seen.add(row.employeeId);
    if (row.goal && !model.setGoal(row.employeeId, row.goal.role, row.goal.grade)) throw new Error('Неизвестная карьерная цель.');
    const completed = row.simulated ?? [];
    if (!Array.isArray(completed) || completed.length > data.events.length || new Set(completed).size !== completed.length) throw new Error('Некорректный список завершений.');
    for (const id of completed) if (!model.complete(row.employeeId, id)) throw new Error('Недопустимое завершение активности.');
  }
  return model;
}
