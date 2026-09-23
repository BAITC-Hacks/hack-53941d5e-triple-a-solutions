import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createModel } from '../prototype/model.mjs';
import { validateDataset } from './validate.mjs';

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}
export const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
export const fingerprint = (data, rules) => createHash('sha256').update(JSON.stringify({ data, rules })).digest('hex');

export class Store {
  constructor(path, input, rules) {
    const result = validateDataset(input, rules);
    if (!result.valid) fail(422, 'INVALID_DATASET', 'Датасет не прошёл проверку', result.errors);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS dataset (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, rules TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, skills TEXT NOT NULL, goal TEXT);
      CREATE TABLE IF NOT EXISTS completions (id INTEGER PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), event_id TEXT NOT NULL,
        occurrence TEXT NOT NULL, session_id TEXT, date TEXT NOT NULL, completed_at TEXT NOT NULL, points INTEGER NOT NULL CHECK(points>=0),
        skill_changes TEXT NOT NULL, finished INTEGER NOT NULL, policy_version TEXT NOT NULL,
        UNIQUE(employee_id,event_id,occurrence));
      CREATE TABLE IF NOT EXISTS requests (employee_id TEXT NOT NULL REFERENCES employees(id), key TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
        PRIMARY KEY(employee_id,key));`);
    if (!this.db.prepare('SELECT id FROM dataset').get()) this.seed(result.data, rules);
    const stored = this.db.prepare('SELECT * FROM dataset WHERE id=1').get();
    this.data = JSON.parse(stored.payload); this.rules = JSON.parse(stored.rules); this.version = stored.fingerprint;
    const storedValidation = validateDataset(this.data, this.rules);
    if (!storedValidation.valid) fail(422, 'INVALID_STORED_DATASET', 'Сохранённый датасет некорректен', storedValidation.errors);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  seed(data, rules) {
    // Preserve all original history for reporting, but never replay a one-time gain twice.
    const seen = new Set();
    const repeats = new Set(rules.repeatableEventIds);
    const gainHistory = [...data.history].sort((a, b) => a.date.localeCompare(b.date) || a.record_id.localeCompare(b.record_id)).filter(row => {
      if (row.status !== 'completed' || repeats.has(row.event_id)) return true;
      const key = `${row.employee_id}:${row.event_id}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).sort((a, b) => a.date.localeCompare(b.date) || a.record_id.localeCompare(b.record_id));
    const model = createModel({ ...data, history: gainHistory }, rules);
    const insert = this.db.prepare('INSERT INTO employees(id,skills,goal) VALUES(?,?,?)');
    this.transaction(() => {
      this.db.prepare('INSERT INTO dataset VALUES(1,?,?,?)').run(JSON.stringify(data), JSON.stringify(rules), fingerprint(data, rules));
      for (const e of data.employees) insert.run(e.employee_id, JSON.stringify(model.snapshot(e).levels), e.career_goal ? JSON.stringify(e.career_goal) : null);
    });
  }
  close() { this.db.close(); }
}
