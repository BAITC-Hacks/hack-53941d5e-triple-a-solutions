const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function createImportUi({ getDataset, applyDataset, rerender, toast }) {
  let review = null, busy = false, error = '';
  const selectedFiles = { employees: null, history: null };
  let replaceExisting = false;
  const fileIcon = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>';
  const uploadField = (kind, title, format, accept) => {
    const file = selectedFiles[kind];
    return `<label class="import-upload" data-selected="${Boolean(file)}" ${busy ? 'data-disabled="true"' : ''}>
      <input class="import-file-input" type="file" name="${kind}" aria-label="${title}" aria-describedby="${kind}-format ${kind}-filename" accept="${accept}" ${busy ? 'disabled' : ''}>
      <span class="import-upload-top"><span class="import-file-icon">${fileIcon}</span><span class="import-file-format" id="${kind}-format">${format}</span></span>
      <span class="import-upload-title">${title}</span><span class="import-file-name" id="${kind}-filename" aria-live="polite">${file ? escape(file.name) : 'Файл ещё не выбран'}</span>
      <span class="import-upload-button"><span class="import-upload-caption">${file ? 'Заменить файл' : 'Выбрать файл'}</span><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/></svg></span>
    </label>`;
  };
  const post = async (action, input) => {
    const response = await fetch(`/api/import/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось обработать импорт.');
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
      if (event.target.type === 'file' && Object.hasOwn(selectedFiles, event.target.name)) {
        const file = event.target.files[0] || null;
        selectedFiles[event.target.name] = file;
        const card = event.target.closest('.import-upload');
        card.dataset.selected = String(Boolean(file));
        card.querySelector('.import-file-name').textContent = file?.name || 'Файл ещё не выбран';
        card.querySelector('.import-upload-caption').textContent = file ? 'Заменить файл' : 'Выбрать файл';
      }
      if (event.target.name === 'replace') replaceExisting = event.target.checked;
      review = null;
      document.querySelector('[aria-label="Предпросмотр импорта"]')?.remove();
      return true;
    },
    page() {
      const current = getDataset();
      return `<div class="page-heading"><div><h1>Данные жюри</h1><p class="subtitle">Добавьте профили и историю в текущий каталог.</p></div><span class="tag">${current.data.employees.length} сотрудников · ${current.data.history.length} записей</span></div>
      <section class="panel"><p>Выберите один или оба файла. Перед применением проверим формат, ссылки на навыки и активности, совпадения ID. Файлы хранятся на этом ноутбуке; сам импорт не вызывает AI.</p>
      <form id="import-form"><div class="import-upload-grid">${uploadField('employees', 'Профили сотрудников', 'JSON', '.json,application/json')}${uploadField('history', 'История активностей', 'CSV / JSON', '.csv,.json,text/csv,application/json')}</div>
      <label class="import-option"><input type="checkbox" name="replace" ${replaceExisting ? 'checked' : ''} ${busy ? 'disabled' : ''}> Разрешить замену записей с совпадающими ID</label>
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
      <p class="footnote">Импорт сохраняется при перезапуске. Отмена возвращает набор до последнего импорта. Каталог курсов, навыков и требований берётся из репозитория. После применения выберите сотрудника в разделе «Мой рост». Перед отправкой данных кейса в AI подтвердите разрешение организаторов.</p>`;
    },
    async submit(event) {
      if (event.target.id !== 'import-form') return false;
      event.preventDefault();
      const chosen = Object.entries(selectedFiles).map(([kind, file]) => ({ kind, file })).filter(x => x.file);
      const replace = replaceExisting, version = getDataset().version;
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
        review = null; selectedFiles.employees = null; selectedFiles.history = null; replaceExisting = false;
        applyDataset(result); toast(name === 'import-apply' ? 'Данные применены. Профили доступны в разделе «Мой рост».' : 'Последний импорт отменён.');
      }); return true;
    },
  };
}
