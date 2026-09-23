const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function createImportUi({ getDataset, applyDataset, rerender, toast }) {
  let review = null, busy = false, error = '';
  const post = async (action, input) => {
    const response = await fetch(`/api/import/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || 'Не удалось обработать импорт.');
    return result;
  };
  async function run(task) {
    if (busy) return;
    busy = true; error = ''; rerender();
    try { await task(); } catch (e) { error = e.message; } finally { busy = false; rerender(); }
  }
  return {
    change(event) {
      if (!event.target.closest('#import-form')) return false;
      review = null;
      document.querySelector('[aria-label="Предпросмотр импорта"]')?.remove();
      return true;
    },
    page() {
      const current = getDataset();
      return `<div class="page-heading"><div><h1>Данные жюри</h1><p class="subtitle">Добавьте профили и историю в текущий каталог.</p></div><span class="tag">${current.data.employees.length} сотрудников · ${current.data.history.length} записей</span></div>
      <section class="panel"><p>Выберите один или оба файла. Перед применением проверим формат, ссылки на навыки и активности, совпадения ID. Файлы хранятся на этом ноутбуке; сам импорт не вызывает AI.</p>
      <form id="import-form"><label class="form-field">Профили сотрудников · JSON<input type="file" name="employees" accept=".json,application/json" ${busy ? 'disabled' : ''}></label>
      <label class="form-field">История активностей · CSV или JSON<input type="file" name="history" accept=".csv,.json,text/csv,application/json" ${busy ? 'disabled' : ''}></label>
      <label class="import-option"><input type="checkbox" name="replace" ${busy ? 'disabled' : ''}> Разрешить замену записей с совпадающими ID</label>
      <div class="draft-actions"><button class="button" ${busy ? 'disabled' : ''}>${busy ? 'Обрабатываем…' : 'Проверить файлы'}</button>${current.canUndo ? `<button type="button" class="button secondary" data-action="import-undo" ${busy ? 'disabled' : ''}>Отменить последний импорт</button>` : ''}</div></form>
      <details class="evidence"><summary>Формат и пример файлов</summary><p>JSON: массив сотрудников, один профиль или объект с полем employees. Обязательные поля: employee_id, role, grade, skills, last_review_date. Цель career_goal необязательна. Уровни — целые от 0 до 5; ID навыков и активности должны быть в текущем каталоге.</p>
      <pre class="import-example">${escape(JSON.stringify({ employee_id: 'JURY_DEMO_1', full_name: 'Учебный профиль', role: 'Backend Engineer', grade: 'Junior', career_goal: { target_role: 'Backend Engineer', target_grade: 'Middle' }, skills: { SK_PYTHON: 2, SK_SYSTEM_DESIGN: 1 }, last_review_date: current.data.asOf }, null, 2))}</pre>
      <p>CSV — UTF-8, разделитель запятая. Обязательные колонки:</p><pre class="import-example">record_id,employee_id,event_id,date,status</pre><p>Примеры двух файлов находятся в папке data/examples репозитория. Даты оценок и записей — не позже ${escape(current.data.asOf)}. До 1000 сотрудников, 20 000 записей истории, 5 МБ за один импорт.</p></details></section>
      ${error ? `<div class="notice" role="alert">${escape(error)}</div>` : ''}
      ${review ? `<section class="panel" aria-label="Предпросмотр импорта"><h2>${review.ok ? 'Результат проверки' : 'Исправьте файлы и повторите проверку'}</h2>
      <p>Сотрудники: новых ${review.summary.employees.added}, замен ${review.summary.employees.replaced}, без изменений ${review.summary.employees.skipped}.<br>История: новых ${review.summary.history.added}, замен ${review.summary.history.replaced}, без изменений ${review.summary.history.skipped}.</p>
      ${review.errors.length ? `<ul role="alert">${review.errors.map(s => `<li>${escape(s)}</li>`).join('')}</ul><p>При ошибках ни одна запись не применяется. Показано до 50 ошибок.</p>` : ''}
      <ul>${review.warnings.map(s => `<li>${escape(s)}</li>`).join('')}</ul>
      ${review.changes.length ? `<details class="evidence"><summary>Какие записи изменятся (${review.changes.length})</summary><ul>${review.changes.slice(0, 100).map(c => `<li>${escape(c.id)} · ${c.kind === 'employees' ? 'профиль' : 'история'} · ${c.action === 'add' ? 'добавить' : 'заменить'}</li>`).join('')}</ul>${review.changes.length > 100 ? '<p>Показаны первые 100 записей.</p>' : ''}</details>` : ''}
      ${review.ok && review.token ? `<button class="button" data-action="import-apply" ${busy ? 'disabled' : ''}>Применить импорт</button>` : ''}</section>` : ''}
      <p class="footnote">Импорт сохраняется при перезапуске. Отмена возвращает набор до последнего импорта. Каталог курсов, навыков и требований берётся из репозитория. Добавленные профили доступны через HR-функции. Используйте только синтетические данные. При наличии сохранённых действий импорт и отмена блокируются; используйте отдельную базу.</p>`;
    },
    async submit(event) {
      if (event.target.id !== 'import-form') return false;
      event.preventDefault();
      const form = new FormData(event.target), chosen = ['employees', 'history'].map(kind => ({ kind, file: form.get(kind) })).filter(x => x.file?.size);
      const replace = form.has('replace'), version = getDataset().version;
      review = null;
      await run(async () => {
        if (!chosen.length) throw new Error('Выберите хотя бы один файл.');
        if (chosen.reduce((sum, x) => sum + x.file.size, 0) > 5_000_000) throw new Error('Общий размер файлов — не более 5 МБ.');
        const files = await Promise.all(chosen.map(async ({ kind, file }) => ({ kind, name: file.name, text: await file.text() })));
        review = await post('preview', { files, replace, version });
      }); return true;
    },
    action(name) {
      if (!['import-apply', 'import-undo'].includes(name)) return false;
      if (busy || (name === 'import-apply' && !review?.token)) return true;
      void run(async () => {
        const result = await post(name === 'import-apply' ? 'commit' : 'undo', { version: name === 'import-apply' ? review.version : getDataset().version, token: review?.token });
        review = null; applyDataset(result); toast(name === 'import-apply' ? 'Данные применены. Профили доступны HR.' : 'Последний импорт отменён.');
      }); return true;
    },
  };
}
