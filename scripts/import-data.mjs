const ID = /^[A-Za-z0-9_-]{1,80}$/;
const reservedIds = new Set(['__proto__', 'prototype', 'constructor']);
const statuses = new Set(['completed', 'in_progress', 'dropped', 'no_show', 'declined', 'overdue']);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isoDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export class ImportError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

// RFC 4180 quoting, including embedded newlines, escaped quotes, CRLF and UTF-8 BOM.
export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const pushField = () => { row.push(field); field = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      pushField();
      if (c !== ',') { if (row.some(s => s !== '')) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else if (c === '"' && !field && !closed) quoted = true;
    else { if (closed || c === '"') throw new ImportError('CSV: неверные кавычки.'); field += c; }
  }
  if (quoted) throw new ImportError('CSV: незакрытые кавычки.');
  if (field || row.length || closed) { pushField(); rows.push(row); }
  const headers = rows.shift()?.map(s => s.trim());
  if (!headers || headers.some(s => !s) || new Set(headers).size !== headers.length) throw new ImportError('CSV: пустые или повторные заголовки.');
  if (!['record_id', 'employee_id', 'event_id', 'date', 'status'].every(h => headers.includes(h))) throw new ImportError('CSV: нужны record_id, employee_id, event_id, date, status.');
  return rows.map((values, i) => {
    if (values.length !== headers.length) throw new ImportError(`CSV: запись ${i + 2}, число столбцов не совпадает с заголовком.`);
    return Object.fromEntries(headers.map((h, j) => [h, values[j]]));
  });
}

export function prepareImport(base, input) {
  if (!record(input) || !Array.isArray(input.files) || !input.files.length || input.files.length > 4) throw new ImportError('Выберите от 1 до 4 файлов.');
  if (input.replace != null && typeof input.replace !== 'boolean') throw new ImportError('Некорректный режим замены.');
  const errors = [], warnings = [], incoming = { employees: [], history: [] };
  const fail = message => { if (errors.length < 50) errors.push(message); };
  let bytes = 0;
  for (const file of input.files) {
    if (!record(file) || !['employees', 'history'].includes(file.kind) || typeof file.text !== 'string') throw new ImportError('Неверное описание файла.');
    bytes += Buffer.byteLength(file.text);
    if (bytes > 5_000_000) throw new ImportError('Общий размер файлов — не более 5 МБ.');
    const label = typeof file.name === 'string' ? file.name.slice(0, 120) : file.kind;
    try {
      let parsed;
      if (file.kind === 'history' && !file.text.trimStart().startsWith('[') && !file.text.trimStart().startsWith('{')) parsed = parseCsv(file.text);
      else {
        const value = JSON.parse(file.text.replace(/^\uFEFF/, ''));
        const asOf = value?.asOf || value?.meta?.as_of_date || value?.meta?.as_of;
        if (asOf && asOf !== base.asOf) throw new ImportError(`Дата набора ${asOf} отличается от модельной ${base.asOf}.`);
        parsed = Array.isArray(value) ? value : value?.[file.kind] || (file.kind === 'employees' && value?.employee_id ? [value] : null);
      }
      if (!Array.isArray(parsed) || !parsed.length) throw new ImportError('Файл должен содержать непустой массив записей.');
      const max = file.kind === 'employees' ? 1000 : 20000;
      if (incoming[file.kind].length + parsed.length > max) throw new ImportError(`Слишком много записей: предел ${max}.`);
      incoming[file.kind].push(...parsed.map((value, i) => ({ value, location: `${label}, запись ${i + 1}` })));
    } catch (error) { fail(`${label}: ${error instanceof SyntaxError ? 'Некорректный JSON.' : error.message}`); }
  }
  const employees = new Map(base.employees.map(e => [e.employee_id, e]));
  const history = new Map(base.history.map(r => [r.record_id, r]));
  const skills = new Set(base.skills.map(s => s.skill_id)), events = new Set(base.events.map(e => e.event_id));
  const roles = (role, grade) => base.roleProfiles.some(p => p.role === role && p.grade === grade);
  const summary = { employees: { added: 0, replaced: 0, skipped: 0 }, history: { added: 0, replaced: 0, skipped: 0 } };
  const changes = [];
  const merge = (kind, id, item, map, location) => {
    const old = map.get(id);
    // Compare normalized nested objects as well, independently of JSON property order.
    const stable = value => Array.isArray(value) ? value.map(stable) : record(value)
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
    if (old && JSON.stringify(stable(old)) === JSON.stringify(stable(item))) { summary[kind].skipped++; return; }
    if (old && !input.replace) { fail(`${location}: ID ${id} уже существует с другими данными. Для замены включите переключатель.`); return; }
    map.set(id, item); summary[kind][old ? 'replaced' : 'added']++;
    changes.push({ kind, id, action: old ? 'replace' : 'add' });
  };
  for (const kind of ['employees', 'history']) {
    const seen = new Set();
    for (const { value: v, location } of incoming[kind]) {
      try {
        if (!record(v)) throw new ImportError('Ожидается объект записи.');
        const id = v[kind === 'employees' ? 'employee_id' : 'record_id'];
        if (typeof id !== 'string' || !ID.test(id) || reservedIds.has(id) || seen.has(id)) throw new ImportError('ID неверный, зарезервирован или повторяется внутри импорта.');
        seen.add(id);
        if (kind === 'employees') {
          if (!roles(v.role, v.grade)) throw new ImportError('Неизвестная роль или грейд.');
          if (!record(v.skills) || Object.entries(v.skills).some(([k, n]) => !skills.has(k) || !Number.isInteger(n) || n < 0 || n > 5)) throw new ImportError('Навыки: известные skill_id, целые уровни от 0 до 5.');
          if (v.career_goal != null && (!record(v.career_goal) || !roles(v.career_goal.target_role, v.career_goal.target_grade))) throw new ImportError('Неизвестная карьерная цель.');
          if (!isoDate(v.last_review_date) || v.last_review_date > base.asOf) throw new ImportError('Нужна last_review_date в формате YYYY-MM-DD, не позже модельной даты.');
          if (v.hire_date && (!isoDate(v.hire_date) || v.hire_date > base.asOf)) throw new ImportError('Неверная дата hire_date.');
          const item = { employee_id: id, full_name: id, role: v.role, grade: v.grade, career_goal: v.career_goal == null ? null : { target_role: v.career_goal.target_role, target_grade: v.career_goal.target_grade }, skills: { ...v.skills }, last_review_date: v.last_review_date };
          for (const key of ['full_name', 'department', 'manager_id', 'hire_date', 'work_format', 'preferred_language']) {
            if (v[key] == null) continue;
            if (typeof v[key] !== 'string' || v[key].length > 200 || (key === 'full_name' && !v[key].trim())) throw new ImportError(`Некорректное поле ${key}.`);
            item[key] = v[key];
          }
          if (v.tenure_months != null) { if (!Number.isInteger(v.tenure_months) || v.tenure_months < 0 || v.tenure_months > 1200) throw new ImportError('Некорректный стаж.'); item.tenure_months = v.tenure_months; }
          merge(kind, id, item, employees, location);
        } else {
          if (!employees.has(v.employee_id) || !events.has(v.event_id)) throw new ImportError('Неизвестный employee_id или event_id.');
          if (!isoDate(v.date) || v.date > base.asOf || (v.due_date && !isoDate(v.due_date))) throw new ImportError('Некорректная дата истории или date позже модельной даты.');
          if (!statuses.has(v.status)) throw new ImportError('Неизвестный статус истории.');
          const item = { record_id: id, employee_id: v.employee_id, event_id: v.event_id, date: v.date, due_date: v.due_date || '', status: v.status };
          for (const [key, max] of [['completion_pct', 100], ['score', 100], ['feedback_rating', 5]]) {
            const val = v[key];
            if (val != null && val !== '' && (!['string', 'number'].includes(typeof val) || !String(val).trim() || !Number.isFinite(Number(val)) || Number(val) < 0 || Number(val) > max)) throw new ImportError(`Некорректное поле ${key}: от 0 до ${max}.`);
            item[key] = val == null ? '' : String(val);
          }
          if (v.assigned_by != null && (typeof v.assigned_by !== 'string' || v.assigned_by.length > 200)) throw new ImportError('Некорректное поле assigned_by.');
          item.assigned_by = v.assigned_by || '';
          merge(kind, id, item, history, location);
        }
      } catch (error) { fail(`${location}: ${error.message}`); }
    }
  }
  if (employees.size > 1000 || history.size > 20000) fail('Итоговый набор превышает 1000 сотрудников или 20 000 записей истории.');
  if (!errors.length && !changes.length) warnings.push('Новых данных нет: записи уже присутствуют в наборе.');
  if (summary.employees.replaced) warnings.push('Замена профиля сохраняет его существующую историю. Уровни навыков должны соответствовать last_review_date; более поздние завершения приложение учитывает отдельно.');
  warnings.push('После применения локальные планы, черновики и демо-прогресс для прежнего набора не используются. Исходный каталог не меняется.');
  return { ok: !errors.length, errors, warnings, summary, changes, data: errors.length ? null : { ...base, employees: [...employees.values()], history: [...history.values()] } };
}
