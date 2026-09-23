import { createModel, GRADES } from './model.mjs';
import { createAiClient } from './ai-client.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#details');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const roles = {
  'Backend Engineer': 'Бэкенд-разработчик', 'Frontend Engineer': 'Фронтенд-разработчик',
  'Data Analyst': 'Аналитик данных', 'QA Engineer': 'Инженер по тестированию',
  'Product Manager': 'Продакт-менеджер', 'HR Business Partner': 'HR-бизнес-партнёр',
  'Sales Manager': 'Менеджер по продажам', 'Customer Support Specialist': 'Специалист поддержки',
};
const eventTitles = ['Информационная безопасность', 'Защита персональных данных', 'Этика и безопасность на работе',
  'Знакомство с компанией', 'Основы системного дизайна', 'Архитектура высоконагруженных систем',
  'Разбор архитектуры с ментором', 'Деловая переписка и документация', 'Подготовка к облачной сертификации',
  'Kubernetes на практике', 'Безопасный код', 'Продвинутый Python', 'TypeScript: погружение',
  'Производительность веба: углублённо', 'Основы веб-производительности', 'Доступные интерфейсы',
  'React: паттерны и состояние', 'Автоматизация тестирования', 'Тестирование API и нагрузки',
  'Прикладная статистика', 'Практикум по A/B-тестам', 'SQL и BI для аналитики', 'Визуализация и истории в данных',
  'Машинное обучение для аналитиков', 'Моделирование аналитических данных', 'Лаборатория Product Discovery',
  'Планирование продукта и Agile', 'Трудовое право и отношения в команде', 'People Analytics и вознаграждение',
  'Структурированное интервью', 'Разработка программ обучения', 'Мастерская переговоров',
  'Консультативные продажи', 'Сложные разговоры с клиентами', 'Решение технических проблем',
  'Клуб публичных выступлений', 'Траектория ментора', 'Основы лидерства', 'Время и приоритеты', 'Системное решение проблем'];
const formats = { online: 'Онлайн', offline: 'Очно', self_paced: 'В своём темпе' };
const types = { course: 'Курс', workshop: 'Практикум', mentoring: 'Менторство', certification: 'Сертификация', meetup: 'Клуб', compliance: 'Обязательное', onboarding: 'Онбординг' };
const statuses = { completed: 'Завершено', in_progress: 'В процессе', dropped: 'Прервано', no_show: 'Пропуск', declined: 'Отказ от участия', overdue: 'Срок прошёл' };
const paths = {
  chart: '<path d="M5 19V12m7 7V5m7 14V9"/>',
  road: '<path d="M4 18h4v-5h7V7h5M17 4l3 3-3 3"/>',
  team: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 4a4 4 0 0 1 3 4"/>',
  book: '<path d="M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v15h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3zM12 6v15"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
};
const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
const title = event => eventTitles[Number(event.event_id.slice(3)) - 1] || event.title;
const roleName = role => roles[role] || role;
const initials = name => name.split(' ').slice(0, 2).map(part => part[0]).join('');
const date = value => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(value + 'T12:00:00'));
let data, model, employeeId = 'E0005', view = 'employee', toastTimer;
const aiClient = createAiClient();
let aiStatus = { ready: false, message: 'Проверяем доступность AI…' }, aiMode = false;

function recommendationView(employee) {
  const state = model.snapshot(employee);
  const local = model.recommend(employee);
  const ai = aiClient.get(state);
  const valid = ai.result?.source === 'ai' && ai.result.recommendations.length > 0
    && ai.result.recommendations.every(row => local.some(item => item.event.event_id === row.event_id));
  return { state, local, ai, isAi: Boolean(valid),
    recs: valid ? ai.result.recommendations.map(row => ({ ...local.find(item => item.event.event_id === row.event_id), ai: row })) : local.slice(0, 3) };
}

function aiPanel(selection) {
  const { ai, isAi, local } = selection;
  const loading = ai.status === 'loading';
  const message = loading ? 'Сопоставляем карьерную цель, разрывы в навыках и историю. Пока доступны рекомендации по правилам.'
    : ai.result?.message || aiStatus.message;
  return `<section class="ai-panel" aria-label="AI-подбор"><div><strong>${loading ? 'Подбираем с AI…' : isAi ? 'Ваш следующий шаг выбран с AI' : 'Персональный подбор'}</strong>
    <p role="status">${escape(message)}</p></div><div class="ai-actions">
    <button class="button ${isAi ? 'secondary' : ''}" data-action="ai" ${loading || !aiStatus.ready || !local.length ? 'disabled' : ''}>${loading ? 'Подбираем…' : isAi ? 'Обновить подбор' : 'Подобрать с AI'}</button>
    ${isAi ? '<button class="button ghost" data-action="compare">Сравнить с подбором по правилам</button>' : ''}</div></section>`;
}

async function requestAi() {
  if (!aiStatus.ready || view !== 'employee') return;
  const employee = data.employees.find(person => person.employee_id === employeeId);
  if (!model.recommend(employee).length) return;
  aiMode = true;
  const pending = aiClient.request(model.snapshot(employee));
  render();
  await pending;
  render();
}

function refreshAiAfterChange() {
  if (aiMode && view === 'employee') void requestAi();
}

function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 4500);
}

function courseCard(item, index) {
  const { event, impact, session, ongoing } = item;
  const main = impact.find(skill => skill.critical) || impact[0];
  return `<article class="course">
    <div class="course-top"><span class="course-icon">${icon(event.type === 'mentoring' ? 'team' : 'book', 23)}</span>
      <span class="tag ${index === 0 ? 'priority' : ''}">${ongoing ? 'Уже в процессе' : index === 0 ? 'Начните с этого' : types[event.type]}</span></div>
    <h3>${escape(title(event))}</h3>
    <div class="course-meta">${escape(formats[event.format])} · ${event.duration_hours} ч · ${session ? date(session) : 'В любое время'}</div>
    <p class="course-reason">${item.ai ? escape(item.ai.reason) : `${main.critical ? 'Закрывает критичный пробел' : 'Приближает к вашей цели'}: ${escape(main.name)} — сейчас ${main.level}, для цели нужен уровень ${main.required}.`}</p>
    <div class="impact"><span>${escape(main.name)}</span><strong>${main.level} → ${main.after}</strong></div>
    <div class="course-actions"><button class="button secondary" data-action="details" data-event="${escape(event.event_id)}">Почему мне?</button>
      <button class="button ghost" data-action="complete" data-event="${escape(event.event_id)}">Пройти в демо ${icon('arrow', 15)}</button></div>
  </article>`;
}

function skillRow(skill) {
  const pct = Math.min(100, skill.level / skill.required * 100);
  return `<div class="skill"><div class="skill-line"><span class="skill-label">${escape(skill.name)}${skill.critical ? '<span class="critical">Ключевой</span>' : ''}</span><b>${skill.level} / ${skill.required}</b></div>
    <div class="meter" role="progressbar" aria-label="${escape(skill.name)}: ${skill.level} из ${skill.required}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct}%"></span></div></div>`;
}

function employeePage(employee) {
  const selection = recommendationView(employee);
  const { state, recs } = selection;
  const history = [...state.simulated].reverse().map(id => ({ event_id: id, date: data.asOf, status: 'completed', demo: true }))
    .concat([...state.history].reverse()).slice(0, 4);
  const sameRole = state.goal.role === employee.role;
  const goalHeading = sameRole ? `${employee.grade} → ${state.goal.grade}` : `${roleName(state.goal.role)} · ${state.goal.grade}`;
  const goalDescription = state.goal.assumed ? 'Цель пока не задана. Мы показали возможный ориентир — вы можете выбрать свой.'
    : `Ваша цель: ${roleName(state.goal.role)}. ${state.gaps.length ? `Навыков для развития: ${state.gaps.length}. Начните с одного подходящего шага.` : 'Требования по навыкам закрыты. Следующий шаг обсудите с руководителем.'}`;
  return `<div class="page-heading"><div><h1>Мой план развития</h1><p class="subtitle">${escape(employee.full_name)} · ${escape(roleName(employee.role))}</p></div>
    <div class="picker"><label for="employee-picker">Посмотреть другого сотрудника</label><select id="employee-picker">${data.employees.map(person => `<option value="${escape(person.employee_id)}" ${person.employee_id === employeeId ? 'selected' : ''}>${escape(person.full_name)} · ${person.grade}</option>`).join('')}</select></div></div>
    <section class="hero" aria-label="Карьерная цель"><div><p class="eyebrow">${state.goal.assumed ? 'Возможная траектория' : 'Ваша траектория'}</p><h2>${escape(goalHeading)}</h2>
      <p class="subline">${escape(goalDescription)}</p><button class="button" data-action="goal">Выбрать цель ${icon('arrow', 16)}</button>
      ${sameRole ? `<div class="career-track" aria-label="Грейды">${GRADES.map((grade, index) => `${index ? '<span class="track-line"></span>' : ''}<span class="stage ${grade === employee.grade ? 'current' : grade === state.goal.grade ? 'target' : ''}"><i></i>${grade}</span>`).join('')}</div>` : ''}</div>
      <div class="ring" style="--value:${state.coverage}"><div class="ring-inner"><b>${state.coverage}%</b><span>требований по навыкам закрыто</span></div></div></section>
    <div class="section-head"><h2>Ваш следующий шаг</h2><span>${selection.isAi ? 'Выбор AI · факты из профиля' : 'Подбор по правилам'}</span></div>
    ${aiPanel(selection)}
    ${recs.length ? `<div class="cards">${recs.map(courseCard).join('')}</div>` : `<div class="empty"><h3>${state.gaps.length ? 'В каталоге пока нет подходящего шага' : 'Требования по навыкам закрыты'}</h3><p>${state.gaps.length ? 'Мы проверили роль, грейд, условия участия и историю. Можно обсудить новую активность с HR или изменить цель.' : 'Курсы не означают автоматическое повышение. Обсудите дальнейший путь с руководителем.'}</p></div>`}
    <div class="two-columns"><section class="panel"><h2>Навыки для цели</h2><p class="panel-intro">Текущий уровень / требуемый. Сначала — ключевые навыки.</p>${state.requirements.slice(0, 5).map(skillRow).join('')}
      <button class="button ghost" style="margin-top:15px" data-action="skills">Все навыки (${state.requirements.length}) ${icon('arrow', 15)}</button></section>
      <section class="panel"><h2>Последняя активность</h2><p class="panel-intro">История обучения и ваши шаги в этом макете.</p>${history.map(row => `<div class="history-row"><div class="history-icon ${row.status === 'completed' ? '' : 'neutral'}">${icon(row.status === 'completed' ? 'check' : 'clock', 15)}</div><div><strong>${escape(title(model.eventMap.get(row.event_id)))}</strong><p>${row.demo ? 'Только в демо' : date(row.date)} · ${statuses[row.status] || escape(row.status)}</p></div></div>`).join('') || '<p class="subtitle">Истории пока нет.</p>'}</section></div>
    <p class="footnote">Прогресс показывает покрытие требований по навыкам, а не вероятность повышения. Завершения после оценки учитываются по дате из истории; для самостоятельных курсов это приближение. Все изменения в макете сбрасываются при обновлении страницы.</p>`;
}

function hrPage() {
  const overview = model.overview();
  const people = overview.noSteps.slice(0, 6);
  return `<div class="page-heading"><div><h1>Развитие команды</h1><p class="subtitle">Где нужна поддержка и каких возможностей пока не хватает.</p></div><span class="tag">${data.employees.length} синтетических профилей</span></div>
    <div class="notice">Это демонстрация экрана HR. Переключение ролей открыто для знакомства с продуктом; авторизация и разграничение доступа пока не реализованы.</div>
    <div class="stats"><div class="stat"><span>Сотрудников</span><b>${data.employees.length}</b><small>8 профессиональных ролей</small></div>
      <div class="stat"><span>Нужно выбрать цель</span><b>${overview.noGoal}</b><small>Пока показана предполагаемая</small></div>
      <div class="stat"><span>Нет следующего шага</span><b>${overview.noSteps.length}</b><small>Есть пробелы, нет активности</small></div>
      <div class="stat"><span>Завершений обучения</span><b>${overview.activityCount.toLocaleString('ru-RU')}</b><small>За весь период истории и демо</small></div></div>
    <div class="two-columns"><section class="panel"><h2>Частые пробелы в навыках</h2><p class="panel-intro">Число сотрудников с пробелом относительно выбранной или предполагаемой цели.</p>
      ${overview.shortages.slice(0, 6).map(skill => `<div class="skill"><div class="skill-line"><span>${escape(skill.name)}</span><b>${skill.count} чел.</b></div><div class="meter"><span style="width:${skill.count / data.employees.length * 100}%"></span></div></div>`).join('')}</section>
      <section class="panel"><h2>Участие в активностях</h2><p class="panel-intro">Все ${data.history.length.toLocaleString('ru-RU')} записей исходной истории. Пропуск сам по себе не объясняет причину.</p>
      ${Object.entries(statuses).map(([key, label]) => { const count = data.history.filter(row => row.status === key).length; return `<div class="skill"><div class="skill-line"><span>${label}</span><b>${count.toLocaleString('ru-RU')}</b></div><div class="meter"><span style="width:${count / data.history.length * 100}%"></span></div></div>`; }).join('')}</section></div>
    <div class="section-head"><h2>Помочь с подбором следующего шага</h2><span>Первые ${people.length} из ${overview.noSteps.length} · без рейтинга сотрудников</span></div>
    <section class="panel table-wrap">${people.length ? `<table><thead><tr><th>Сотрудник</th><th>Цель</th><th>Что мешает</th><th></th></tr></thead><tbody>${people.map(state => `<tr><td><div class="person-cell"><span class="avatar">${escape(initials(state.employee.full_name))}</span><span>${escape(state.employee.full_name)}<small>${escape(roleName(state.employee.role))} · ${state.employee.grade}</small></span></div></td><td>${escape(roleName(state.goal.role))}<small>${state.goal.grade}${state.goal.assumed ? ' · предположение' : ''}</small></td><td>Нет допустимой активности<small>Пробелов в навыках: ${state.gaps.length}</small></td><td><button class="row-button" data-action="person" data-person="${state.employee.employee_id}">Профиль →</button></td></tr>`).join('')}</tbody></table>` : '<p class="subtitle">Для всех сотрудников с пробелами найден хотя бы один следующий шаг.</p>'}</section>
    <p class="footnote">Сведения о навыках используются для поддержки развития. Сравнительный рейтинг сотрудников не рассчитывается. Данные — учебный набор Career Quest.</p>`;
}

function render() {
  const employee = data.employees.find(person => person.employee_id === employeeId) || data.employees[0];
  employeeId = employee.employee_id;
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div><div class="brand"><span class="brand-mark">${icon('chart', 23)}</span>Career Quest</div><div class="workspace">ПРОСТРАНСТВО РАЗВИТИЯ</div></div>
    <nav aria-label="Основные разделы"><p class="nav-label">Рабочее пространство</p><button class="nav-button ${view === 'employee' ? 'active' : ''}" ${view === 'employee' ? 'aria-current="page"' : ''} data-action="employee">${icon('road')}Мой рост</button>
      <button class="nav-button ${view === 'hr' ? 'active' : ''}" ${view === 'hr' ? 'aria-current="page"' : ''} data-action="hr">${icon('team')}Обзор HR</button></nav>
    <div class="sidebar-note"><strong>Ваш следующий шаг</strong>Выберите цель, сравните рекомендации и посмотрите, какие навыки развивает активность.<br><br>${aiStatus.ready ? 'AI помогает выбрать шаг. Прирост навыков рассчитывается по данным.' : 'Пока доступен подбор по правилам.'}</div>
    <div class="sidebar-bottom"><span class="avatar">${view === 'hr' ? 'HR' : escape(initials(employee.full_name))}</span><div>${view === 'hr' ? 'Режим HR' : escape(employee.full_name.split(' ')[0])}<small>${view === 'hr' ? 'Демонстрация роли' : employee.grade + ' · учебный профиль'}</small></div></div></aside>
    <main class="main"><header class="topbar"><div class="breadcrumb"><span>Рабочее пространство /</span><strong>${view === 'hr' ? 'Обзор HR' : 'Мой рост'}</strong></div>
      <div class="top-actions"><span class="prototype-badge">Черновой прототип</span><button class="button secondary" data-action="reset">Сбросить демо</button></div></header>
      <div class="content">${view === 'hr' ? hrPage() : employeePage(employee)}<p class="footnote">Модельная дата: ${date(data.asOf)} 2026 · HackAlem AI</p></div></main></div>`;
}

function openDialog(content) {
  dialog.innerHTML = content;
  if (!dialog.open) dialog.showModal();
}

const dialogHead = heading => `<div class="dialog-head"><h2 id="dialog-title">${escape(heading)}</h2><button class="close" data-action="close" aria-label="Закрыть">×</button></div>`;

function showDetails(id) {
  const employee = data.employees.find(person => person.employee_id === employeeId);
  const state = model.snapshot(employee);
  const item = model.recommend(employee).find(row => row.event.event_id === id);
  if (!item) return;
  const ai = recommendationView(employee).recs.find(row => row.event.event_id === id)?.ai;
  openDialog(`${dialogHead(title(item.event))}<p>${escape(formats[item.event.format])} · ${item.event.duration_hours} ч · ${item.session ? date(item.session) : 'В любое время'}</p>
    ${ai ? `<div class="ai-explanation"><h3>Почему AI выбрал этот шаг</h3><p>${escape(ai.reason)}</p><details><summary>Факты, на которые опирается рекомендация</summary><ul>${ai.evidence.map(fact => `<li>${escape(fact.text)}</li>`).join('')}</ul></details></div>` : ''}
    <div class="reason-block"><h3>01 · Ваша карьерная цель</h3><p>${escape(roleName(state.goal.role))}, ${state.goal.grade}. ${state.goal.assumed ? 'Это пока предположение — цель можно изменить.' : 'Цель указана в профиле.'}</p></div>
    <div class="reason-block"><h3>02 · Конкретный вклад в навыки</h3><p>${item.impact.map(skill => `${escape(skill.name)}: ${skill.level} → ${skill.after}, требуется ${skill.required}${skill.critical ? ' (ключевой навык)' : ''}`).join('<br>')}</p></div>
    <div class="reason-block"><h3>03 · История участия</h3><p>${item.successes ? `Завершённых активностей такого типа и формата: ${item.successes}. ` : 'Завершённых активностей такого типа и формата пока нет. '}${item.setbacks ? `Пропуски, отказы или прерывания: ${item.setbacks}. Этот сигнал снижает приоритет, но не определяет вашу мотивацию.` : 'Пропусков, отказов и прерываний такого типа и формата в истории нет.'}${item.ongoing ? ' Эта активность уже начата.' : ''}</p></div>
    <div class="reason-block"><h3>04 · Доступность</h3><p>Подходит вашей текущей роли и грейду. ${Object.keys(item.event.prerequisites).length ? 'Предварительные требования к навыкам выполнены.' : 'Предварительных требований нет.'} ${item.event.event_id === 'EV_036' ? 'Клуб допускает повторное участие.' : 'Курс ещё не завершён.'}</p></div>
    <p>${ai ? 'Приоритет и пояснение предложены AI. Числовой прирост и факты рассчитаны приложением. Рекомендация не гарантирует повышение.' : 'Это объяснение подбора по правилам датасета.'}</p><div class="dialog-actions"><button class="button" data-action="complete" data-event="${escape(id)}">Пройти в демо ${icon('check', 17)}</button></div>`);
}

function compareDialog() {
  const employee = data.employees.find(person => person.employee_id === employeeId);
  const selection = recommendationView(employee);
  if (!selection.isAi) return;
  const list = rows => `<ol>${rows.map(item => `<li><strong>${escape(title(item.event))}</strong><p>${item.impact.map(s => `${escape(s.name)}: ${s.level} → ${s.after} / ${s.required}`).join('; ')}</p></li>`).join('')}</ol>`;
  openDialog(`${dialogHead('Два варианта следующего шага')}<div class="comparison"><section><h3>Подбор по правилам</h3>${list(selection.local.slice(0, 3))}</section><section><h3>Выбор AI</h3>${list(selection.recs)}</section></div>
    <p>Оба варианта соблюдают условия участия. Разница в выборе сама по себе не означает улучшение: оцените пользу для цели, подходящий формат и объяснение.</p>
    <p>Ответ модели: ${escape(selection.ai.result.model)} · ${selection.ai.result.cached ? 'из кеша' : `${(selection.ai.result.elapsedMs / 1000).toFixed(1)} с`}.</p>`);
}

function goalDialog() {
  const state = model.snapshot(data.employees.find(person => person.employee_id === employeeId));
  const roleList = [...new Set(data.roleProfiles.map(item => item.role))];
  openDialog(`${dialogHead('Куда вы хотите развиваться?')}<form id="goal-form"><label class="form-field">Роль<select name="role" aria-label="Роль">${roleList.map(role => `<option value="${escape(role)}" ${role === state.goal.role ? 'selected' : ''}>${escape(roleName(role))}</option>`).join('')}</select></label>
    <label class="form-field">Грейд<select name="grade" aria-label="Грейд">${GRADES.map(grade => `<option ${grade === state.goal.grade ? 'selected' : ''}>${grade}</option>`).join('')}</select></label>
    <p class="subtitle">Изменение цели пересчитает рекомендации. Это локальная симуляция; исходный профиль останется прежним.</p><div class="dialog-actions"><button type="button" class="button secondary" data-action="close">Отмена</button><button type="submit" class="button">Сохранить цель</button></div></form>`);
}

function action(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const actionName = button.dataset.action;
  if (actionName === 'ai') { void requestAi(); return; }
  if (actionName === 'compare') return compareDialog();
  if (actionName === 'close') return dialog.close();
  if (actionName === 'details') return showDetails(button.dataset.event);
  if (actionName === 'goal') return goalDialog();
  if (actionName === 'skills') {
    const state = model.snapshot(data.employees.find(person => person.employee_id === employeeId));
    return openDialog(`${dialogHead('Навыки для вашей цели')}<p style="margin-bottom:20px">Текущий уровень / требуемый уровень.</p>${state.requirements.map(skillRow).join('')}`);
  }
  if (actionName === 'complete') {
    if (model.complete(employeeId, button.dataset.event)) {
      dialog.close(); render(); toast('Активность завершена в демо. Навыки и рекомендации пересчитаны.'); refreshAiAfterChange();
    } else toast('Активность уже завершена или больше не подходит.');
    return;
  }
  if (actionName === 'reset') { model.reset(); aiClient.reset(); aiMode = false; dialog.close(); render(); toast('Изменения демо сброшены. Исходные данные восстановлены.'); return; }
  if (actionName === 'person') { employeeId = button.dataset.person; view = 'employee'; }
  else view = actionName === 'hr' ? 'hr' : 'employee';
  render(); window.scrollTo({ top: 0, behavior: 'instant' });
}

app.addEventListener('click', action);
dialog.addEventListener('click', action);
app.addEventListener('change', event => {
  if (event.target.id === 'employee-picker') { employeeId = event.target.value; render(); document.querySelector('#employee-picker')?.focus(); refreshAiAfterChange(); }
});
dialog.addEventListener('submit', event => {
  if (event.target.id !== 'goal-form') return;
  event.preventDefault();
  const form = new FormData(event.target);
  if (model.setGoal(employeeId, form.get('role'), form.get('grade'))) {
    dialog.close(); render(); toast('Цель обновлена. Подобрали следующие шаги.'); refreshAiAfterChange();
  }
});

try {
  const response = await fetch('./data.json');
  if (!response.ok) throw new Error('Нет локального файла данных');
  data = await response.json();
  if (!data.employees?.length || !data.events?.length) throw new Error('Неполный набор данных');
  model = createModel(data);
  render();
  fetch('/api/ai/status').then(response => {
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  }).then(status => { aiStatus = status; render(); }).catch(() => {
    aiStatus = { ready: false, message: 'Доступен подбор по правилам. AI-сервис сейчас не подключён.' }; render();
  });
} catch (error) {
  app.innerHTML = `<main class="loading"><h1>Не удалось открыть данные</h1><p>Подготовьте локальный набор командой из README прототипа и обновите страницу.</p><p>${escape(error.message)}</p></main>`;
}
