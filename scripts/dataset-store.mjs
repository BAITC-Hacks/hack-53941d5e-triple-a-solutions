import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { prepareImport, ImportError } from './import-data.mjs';

const fingerprint = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export function createDatasetStore(base, file) {
  const baseVersion = fingerprint(base);
  let data = structuredClone(base), previous = null, imported = false;
  const previews = new Map();
  if (file && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.baseVersion !== baseVersion) throw new Error('Исходный набор изменился. Сохраните artifacts/imported-dataset.json отдельно и повторите импорт в новый набор.');
    // Revalidate local imports on restart; catalog always comes from the repository.
    const restore = value => {
      if (!value || !Array.isArray(value.employees) || !Array.isArray(value.history)) throw new Error('Повреждён файл локального импорта.');
      const result = prepareImport(base, { replace: true, files: [
        { kind: 'employees', text: JSON.stringify(value.employees) },
        ...(value.history.length ? [{ kind: 'history', text: JSON.stringify(value.history) }] : []),
      ] });
      if (!result.ok) throw new Error('Файл локального импорта не прошёл проверку. Исходные данные не изменены.');
      // Keep the exact validated serialization so dataset versions survive restart.
      return { ...base, employees: value.employees, history: value.history };
    };
    data = restore(saved.data); previous = saved.previous ? restore(saved.previous) : null; imported = Boolean(saved.imported);
  }
  const snapshot = () => ({ data, version: fingerprint(data), canUndo: Boolean(previous), imported });
  const check = version => { if (version !== snapshot().version) throw new ImportError('Данные изменились. Обновите страницу и повторите предпросмотр.', 409); };
  const persist = (next, prior, flag) => {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ baseVersion, data: next, previous: prior, imported: flag }), { encoding: 'utf8', mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    }
    data = next; previous = prior; imported = flag; previews.clear();
  };
  return { snapshot,
    preview(input) {
      check(input.version);
      const { data: next, ...review } = prepareImport(data, input);
      const token = review.ok && review.changes.length ? randomUUID() : null;
      if (token) {
        if (previews.size >= 5) previews.delete(previews.keys().next().value);
        previews.set(token, { next, version: input.version, expires: Date.now() + 600_000 });
      }
      return { ...review, token, version: input.version };
    },
    commit(input) {
      check(input.version);
      const pending = previews.get(input.token);
      if (!pending || pending.version !== input.version || pending.expires < Date.now()) throw new ImportError('Предпросмотр устарел. Проверьте файлы заново.', 409);
      persist(pending.next, data, true); return snapshot();
    },
    undo(input) {
      check(input.version);
      if (!previous) throw new ImportError('Нет импорта для отмены.');
      const next = previous; persist(next, null, fingerprint(next) !== baseVersion); return snapshot();
    },
  };
}
