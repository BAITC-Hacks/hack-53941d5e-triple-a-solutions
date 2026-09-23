import { randomUUID } from 'node:crypto';
import { prepareImport } from '../../scripts/import-data.mjs';
import { validateDataset } from './validate.mjs';
import { fail, fingerprint } from './store.mjs';
import { createModel } from '../prototype/model.mjs';
import { CareerService } from './service.mjs';

export function createImports(store, getService, setService, employeeId) {
  store.db.exec('CREATE TABLE IF NOT EXISTS dataset_undo (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, rules TEXT NOT NULL)');
  const previews = new Map();
  const snapshot = () => ({ data: store.data, version: store.version, canUndo: !!store.db.prepare('SELECT id FROM dataset_undo').get() });
  const check = version => { if (version !== store.version) fail(409, 'STALE_DATASET', 'Набор изменился. Обновите страницу.'); };
  function replace(input, rules = store.rules, undo = false) {
    const result = validateDataset(input, rules), service = getService();
    if (!result.valid) fail(422, 'INVALID_DATASET', 'Датасет не прошёл проверку', result.errors);
    if (!result.data.employees.some(e => e.employee_id === employeeId)) fail(422, 'MISSING_ACCOUNT', 'Набор не содержит настроенного сотрудника');
    if (result.data.asOf > service.asOf) fail(422, 'FUTURE_DATASET', 'Срез позже модельной даты сервера');
    const version = fingerprint(result.data, rules);
    if (version === store.version) return { imported: false, unchanged: true, counts: result.counts };
    store.transaction(() => {
      const edited = store.db.prepare('SELECT id,goal FROM employees').all().some(e => e.goal !== (service.originalEmployees.get(e.id).career_goal ? JSON.stringify(service.originalEmployees.get(e.id).career_goal) : null));
      if (edited || store.db.prepare('SELECT count(*) AS n FROM completions').get().n) fail(409, 'IMPORT_WOULD_OVERWRITE', 'Есть сохранённые действия. Для импорта или отмены используйте отдельную базу.');
      if (undo) store.db.exec('DELETE FROM dataset_undo');
      else store.db.prepare('INSERT OR REPLACE INTO dataset_undo VALUES(1,?,?)').run(JSON.stringify(store.data), JSON.stringify(store.rules));
      const seen = new Set(), repeats = new Set(rules.repeatableEventIds);
      const history = result.data.history.filter(h => {
        if (h.status !== 'completed' || repeats.has(h.event_id)) return true;
        const key = `${h.employee_id}:${h.event_id}`; if (seen.has(key)) return false; seen.add(key); return true;
      });
      const model = createModel({ ...result.data, history }, rules);
      store.db.exec('DELETE FROM requests; DELETE FROM employees;');
      const insert = store.db.prepare('INSERT INTO employees VALUES(?,?,?)');
      for (const e of result.data.employees) insert.run(e.employee_id, JSON.stringify(model.snapshot(e).levels), e.career_goal ? JSON.stringify(e.career_goal) : null);
      store.db.prepare('UPDATE dataset SET payload=?,rules=?,fingerprint=? WHERE id=1').run(JSON.stringify(result.data), JSON.stringify(rules), version);
    });
    store.data = result.data; store.rules = rules; store.version = version;
    setService(new CareerService(store, service.asOf)); previews.clear();
    return { imported: true, counts: result.counts };
  }
  return { snapshot, replace,
    preview(input) {
      check(input.version);
      const result = prepareImport(store.data, input);
      if (result.ok) {
        result.data.employees = result.data.employees.map(e => ({ ...e, department: e.department || 'Не указано' }));
        const checked = validateDataset(result.data, store.rules);
        if (!checked.valid) { result.ok = false; result.errors.push(...checked.errors.map(e => JSON.stringify(e))); }
        else result.data = checked.data;
      }
      const token = result.ok && result.changes.length ? randomUUID() : null;
      if (token) { if (previews.size >= 5) previews.delete(previews.keys().next().value); previews.set(token, { data: result.data, version: input.version, expires: Date.now() + 600000 }); }
      const { data, ...review } = result;
      return { ...review, version: input.version, token };
    },
    commit(input) {
      check(input.version); const pending = previews.get(input.token);
      if (!pending || pending.version !== store.version || pending.expires < Date.now()) fail(409, 'STALE_PREVIEW', 'Проверьте файлы заново.');
      replace(pending.data); return snapshot();
    },
    undo(input) {
      check(input.version); const previous = store.db.prepare('SELECT * FROM dataset_undo').get();
      if (!previous) fail(409, 'NOTHING_TO_UNDO', 'Нет импорта для отмены.');
      replace(JSON.parse(previous.payload), JSON.parse(previous.rules), true); return snapshot();
    },
  };
}
