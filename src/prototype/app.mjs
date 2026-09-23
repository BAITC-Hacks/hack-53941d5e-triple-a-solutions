import { applyGain, createModel, GRADES } from './model.mjs';
import { connectBackend } from './api-client.mjs';

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
const statusNames = { not_started: 'Не начато', completed: 'Завершено', in_progress: 'В процессе', no_show: 'Пропуск', declined: 'Отказ от участия', dropped: 'Прервано', overdue: 'Срок прошёл' };
const formats = { online: 'Онлайн', offline: 'Очно', self_paced: 'В своём темпе' };
const types = { course: 'Курс', workshop: 'Практикум', mentoring: 'Менторство', certification: 'Сертификация', meetup: 'Клуб', compliance: 'Обязательное', onboarding: 'Онбординг' };
const paths = {
  chart: '<path d="M5 19V12m7 7V5m7 14V9"/>', road: '<path d="M4 18h4v-5h7V7h5M17 4l3 3-3 3"/>',
  team: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 4a4 4 0 0 1 3 4"/>',
  book: '<path d="M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v15h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3zM12 6v15"/>',
  check: '<path d="m5 12 4 4L19 6"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>', star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  alert: '<path d="M12 4 3 20h18L12 4Zm0 5v5m0 3h.01"/>',
};
const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
const title = event => event ? (eventTitles[Number(event.event_id.slice(3)) - 1] || event.title) : 'Неизвестная активность';
const roleName = role => roles[role] || role;
const initials = name => name.split(' ').slice(0, 2).map(part => part[0]).join('');
const date = value => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value + 'T12:00:00'));
let data, demoRules, model, employeeId = 'E0066', view = 'employee', toastTimer;

function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 4500);
}

function skillRow(skill) {
  const pct = skill.required ? Math.min(100, skill.level / skill.required * 100) : 100;
  return `<div class="skill"><div class="skill-line"><span class="skill-label">${escape(skill.name)}${skill.critical ? '<span class="critical">Ключевой</span>' : ''}</span><b>${skill.level} / ${skill.required}</b></div>
    <div class="meter" role="progressbar" aria-label="${escape(skill.name)}: ${skill.level} из ${skill.required}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct}%"></span></div></div>`;
}

function courseCard(item, index) {
  const { event, impact, session, ongoing } = item;
  const main = impact.find(skill => skill.critical) || impact[0];
  const skills = impact.map(skill => `${escape(skill.name)} +${skill.gain}`).join(' · ');
  return `<article class="course">
    <div class="course-top"><span class="course-icon">${icon(event.type === 'mentoring' ? 'team' : 'book', 23)}</span>
      <span class="tag ${main.critical ? 'priority' : ''}">${main.critical ? 'Ключевой для цели' : index === 0 ? 'Рекомендуем начать' : 'Нужен для цели'}</span></div>
    <h3>${escape(title(event))}</h3>
    <div class="course-meta">${escape(types[event.type])} · ${escape(formats[event.format])} · ${event.duration_hours} ч · ${session ? date(session) : 'В любое время'}</div>
    <p class="course-reason"><strong>${escape(main.name)}</strong>: сейчас ${main.level}, для роли нужно ${main.required}. Ожидаемый прирост: ${skills}.</p>
    <div class="career-effect"><span>Прогресс к цели</span><strong>${item.coverageAfter > item.coverage ? `${item.coverage}% → ${item.coverageAfter}%` : `ещё ${main.gap} ур.`}</strong></div>
    <div class="point-line">${icon('star', 16)} <b>+${item.points} пойнта</b><span>за завершение</span></div>
    <div class="course-actions"><button class="button secondary" data-action="details" data-event="${escape(event.event_id)}">Почему мне?</button>
      <button class="button ghost" data-action="complete" data-event="${escape(event.event_id)}" ${model.isBackend && !item.canComplete ? 'disabled' : ''}>${model.isBackend ? 'Отметить выполнение' : 'Завершить в демо'} ${icon('arrow', 15)}</button></div>
  </article>`;
}

function sessionCard(employee, state, recommendation) {
  const program = model.programProgress(employee, recommendation?.event.event_id || 'EV_019');
  if (!program || !program.event.target_roles.includes(employee.role) || !program.event.target_grades.includes(employee.grade)) return '';
  const skill = state.requirements.find(item => item.id === program.rule.skillId);
  if (!skill) return '';
  const affected = model.isBackend ? (program.skillImpacts || []).map(s => `${s.name}: ${s.level} → ${s.after}`).join(' · ') : program.event.develops_skills.flatMap(item => {
    const requirement = state.requirements.find(row => row.id === item.skill_id);
    if (!requirement) return [];
    return [`${requirement.name}: ${requirement.level} → ${applyGain(requirement.level, item.gain, item.max_level)}`];
  }).join(' · ');
  const coverageAfter = recommendation?.coverageAfter ?? state.coverage;
  return `<article class="course session-course ${program.finished ? 'finished' : ''}">
    <div class="course-top"><span class="course-icon">${icon(program.finished ? 'check' : 'book', 23)}</span><span class="tag priority">${program.finished ? 'Все сессии завершены' : `Программа из ${program.total} сессий`}</span></div>
    <h3>${escape(title(program.event))}</h3>
    <div class="session-summary"><b>${program.completed} из ${program.total}</b><span>${program.pointsEarned} из ${program.totalPoints} пойнтов</span></div>
    <div class="session-meter"><span style="width:${program.total ? program.completed / program.total * 100 : 0}%"></span></div>
    <div class="session-list">${program.sessions.map(item => `<div class="session-item ${item.completed ? 'done' : ''}"><span>${item.completed ? icon('check', 14) : item.index + 1}</span><div><b>${escape(item.label)}</b><small>${date(item.date)} · ${item.completed ? `завершено, +${program.rule.pointsPerSession} пойнт` : 'ещё не завершено'}</small></div></div>`).join('')}</div>
    <p class="course-reason"><strong>${escape(skill.name)}</strong> — ${skill.critical ? 'ключевой' : 'важный'} навык для ${escape(roleName(state.goal.role))}, ${state.goal.grade}. ${program.finished ? `После программы уровень обновлён до ${skill.level}; до требования осталось ${skill.gap}.` : `После всех сессий: ${escape(affected)}; прогресс к цели ${state.coverage}% → ${coverageAfter}%.`}</p>
    <div class="point-line">${icon('star', 16)} <b>+${program.rule.pointsPerSession} пойнт</b><span>за каждую завершённую сессию</span></div>
    <button class="button session-button" data-action="complete" data-event="${program.event.event_id}" ${program.finished || !recommendation || (model.isBackend && !recommendation.canComplete) ? 'disabled' : ''}>${program.finished ? `Получено ${program.totalPoints} пойнта` : `Завершить сессию ${program.completed + 1}`}</button>
  </article>`;
}

function missedBanner(miss) {
  if (!miss) return '';
  const next = miss.nextStep ? `Следующий полезный шаг: «${title(miss.nextStep.event)}».` : 'Следующий шаг лучше подобрать вместе с HR или руководителем.';
  return `<section class="missed-note">${icon('alert', 22)}<div><strong>Есть важный пропуск, который стоит наверстать</strong><p>Вы пропустили ${miss.count} ${miss.count === 1 ? 'занятие' : 'занятия'} по теме «${escape(title(miss.event))}». Навык ${escape(miss.skill.name)} важен для перехода на выбранную роль; сейчас до требования не хватает ${miss.skill.gap} ур. ${escape(next)}</p><small>Пойнты и уже достигнутый уровень за пропуск не снижаются.</small></div></section>`;
}

function employeePage(employee) {
  const state = model.snapshot(employee);
  const recommendations = model.recommend(employee).map(item => ({ ...item, coverage: state.coverage }));
  const programRecommendation = recommendations.find(item => item.event.event_id === 'EV_019');
  const recs = recommendations.filter(item => item.event.event_id !== 'EV_019').slice(0, programRecommendation ? 2 : 3);
  const miss = model.importantMisses(employee)[0];
  const sameRole = state.goal.role === employee.role;
  const goalHeading = sameRole ? `${employee.grade} → ${state.goal.grade}` : `${roleName(state.goal.role)} · ${state.goal.grade}`;
  const goalDescription = state.goal.assumed ? 'Цель пока не задана. Мы показали возможный ориентир — его можно изменить.'
    : `Ваша цель: ${roleName(state.goal.role)}. ${state.gaps.length ? `До неё нужно развить ${state.gaps.length} навыков.` : 'Требования по навыкам закрыты; следующий шаг обсудите с руководителем.'}`;
  const session = programRecommendation ? sessionCard(employee, state, programRecommendation) : '';
  const cards = recommendations.slice(0, 3).map((item, i) => item.program ? sessionCard(employee, state, item) : courseCard(item, i)).join('');
  return `<div class="page-heading"><div><h1>Мой план развития</h1><p class="subtitle">${escape(employee.full_name)} · ${escape(roleName(employee.role))} · ${employee.grade}</p></div>
    <div class="points-total"><span>${icon('star', 18)} Накоплено</span><b>${state.totalPoints}</b><small>демо-пойнтов</small></div></div>
    <section class="hero" aria-label="Карьерная цель"><div><p class="eyebrow">${state.goal.assumed ? 'Возможная траектория' : 'Ваша траектория'}</p><h2>${escape(goalHeading)}</h2>
      <p class="subline">${escape(goalDescription)}</p><button class="button" data-action="goal">Выбрать цель ${icon('arrow', 16)}</button>
      ${sameRole ? `<div class="career-track" aria-label="Грейды">${GRADES.map((grade, index) => `${index ? '<span class="track-line"></span>' : ''}<span class="stage ${grade === employee.grade ? 'current' : grade === state.goal.grade ? 'target' : ''}"><i></i>${grade}</span>`).join('')}</div>` : ''}</div>
      <div class="ring" style="--value:${state.coverage}"><div class="ring-inner"><b>${state.coverage}%</b><span>требований по навыкам закрыто</span></div></div></section>
    ${missedBanner(miss)}
    <div class="section-head"><h2>Активности и вклад в карьерную цель</h2><span>Пойнты мотивируют, уровни навыков определяют прогресс</span></div>
    ${session || recs.length ? `<div class="cards ${session ? 'with-session' : ''}">${cards}</div>` : `<div class="empty"><h3>${state.gaps.length ? 'В каталоге пока нет подходящего шага' : 'Требования по навыкам закрыты'}</h3><p>${state.gaps.length ? 'Проверены роль, грейд, условия участия и история. Можно обсудить новую активность с HR.' : 'Завершённые курсы не означают автоматическое повышение.'}</p></div>`}
    ${model.isBackend ? '<button class="button secondary" data-action="catalog">Все активности и сессии</button>' : ''}
    <div class="two-columns"><section class="panel"><h2>Навыки для цели</h2><p class="panel-intro">Текущий уровень / требуемый. Сначала показаны ключевые навыки.</p>${state.requirements.slice(0, 6).map(skillRow).join('') || '<p class="subtitle">Для выбранной цели требования не найдены.</p>'}
      ${state.requirements.length > 6 ? `<button class="button ghost" data-action="skills">Все навыки (${state.requirements.length}) ${icon('arrow', 15)}</button>` : ''}</section>
      <section class="panel"><h2>История начислений</h2><p class="panel-intro">За какое действие, когда и сколько пойнтов начислено.</p>${state.pointLedger.slice(0, 6).map(row => `<div class="point-history"><span class="history-icon">${icon('star', 14)}</span><div><strong>${escape(title(model.eventMap.get(row.eventId)))}</strong><p>${escape(row.action.replace(model.eventMap.get(row.eventId)?.title || '', '').replace(/^: /, '') || 'Активность завершена')} · ${date(row.date)}</p></div><b>+${row.points}</b></div>`).join('') || '<div class="empty compact"><p>Начислений пока нет. Завершите первую активность.</p></div>'}<p class="demo-caption">Начисления рассчитаны по временным правилам из отдельного файла. Исторические начисления ретроспективные; правила пойнтов демонстрационные.</p></section></div>
    <p class="footnote">Пойнты не заменяют уровни навыков и требования грейда. Пропуски не уменьшают пойнты или достигнутый уровень. ${model.isBackend ? 'Цель, навыки и начисления сохраняются на сервере.' : 'Все действия демо сбрасываются при обновлении страницы.'}</p>`;
}

function hrPage() {
  const overview = model.overview();
  const people = overview.repeatedImportantMisses.slice(0, 8);
  return `<div class="page-heading"><div><h1>Участие в развитии</h1><p class="subtitle">Пропуски в контексте карьерных целей, без рейтинга сотрудников.</p></div><span class="tag">HR-раздел · ${overview.employeeCount ?? data.employees.length} профилей</span></div>
    <div class="notice">Индивидуальная история доступна только здесь, в HR-разделе. Причина пропуска неизвестна, поэтому данные служат сигналом для поддержки, а не оценкой сотрудника.</div>
    <div class="stats"><div class="stat"><span>Всего пропусков</span><b>${overview.totalMisses}</b><small>Статус no_show в истории</small></div>
      <div class="stat"><span>Повторные важные пропуски</span><b>${overview.repeatedImportantMisses.length}</b><small>2+ пропуска, связанных с целью</small></div>
      <div class="stat"><span>Затронуто навыков</span><b>${overview.missedSkills.length}</b><small>Есть незакрытое требование роли</small></div>
      <div class="stat"><span>Нет следующего шага</span><b>${overview.noSteps.length}</b><small>Есть пробел, нет доступной активности</small></div></div>
    <div class="two-columns"><section class="panel"><h2>Часто пропускаемые мероприятия</h2><p class="panel-intro">События со статусом no_show во всём наборе данных.</p>
      ${overview.eventMisses.slice(0, 6).map(item => `<div class="metric-row"><span>${escape(title(item.event))}<small>${item.employees} сотрудников</small></span><b>${item.count} проп.</b></div>`).join('') || '<p class="subtitle">Пропусков нет.</p>'}</section>
      <section class="panel"><h2>Навыки, связанные с пропусками</h2><p class="panel-intro">Учитываются только навыки, которые нужны для выбранной цели и пока не достигнуты.</p>
      ${overview.missedSkills.slice(0, 6).map(item => `<div class="skill"><div class="skill-line"><span>${escape(item.name)}<small>${item.employees} сотрудников</small></span><b>${item.misses} проп.</b></div><div class="meter warning"><span style="width:${Math.min(100, item.misses / Math.max(1, overview.totalMisses) * 300)}%"></span></div></div>`).join('') || '<p class="subtitle">Связанных с целями пропусков нет.</p>'}</section></div>
    ${model.isBackend ? `<div class="two-columns"><section class="panel"><h2>Частые пробелы навыков</h2>${overview.shortages.slice(0, 6).map(s => `<div class="metric-row"><span>${escape(s.name)}</span><b>${s.count} чел.</b></div>`).join('')}</section>
      <section class="panel"><h2>Участие и карьерные цели</h2><p>Без заданной цели: ${overview.noGoal}. Завершено активностей: ${overview.activityCount}.</p>${Object.entries(overview.participation).map(([status, count]) => `<div class="metric-row"><span>${escape(statusNames[status] || status)}</span><b>${count}</b></div>`).join('')}</section></div>
      <div class="two-columns"><section class="panel"><h2>Нужно выбрать цель</h2>${overview.employeesWithoutGoal.slice(0, 6).map(e => `<div class="metric-row"><span>${escape(e.full_name)}</span><button class="row-button" data-action="hr-person" data-person="${escape(e.employee_id)}">Подробнее →</button></div>`).join('') || '<p>Цели заданы всем.</p>'}<p>Показаны первые 6; всего ${overview.noGoal}.</p></section>
      <section class="panel"><h2>Нет подходящей активности</h2>${overview.noSteps.slice(0, 6).map(s => `<div class="metric-row"><span>${escape(s.employee.full_name)}</span><button class="row-button" data-action="hr-person" data-person="${escape(s.employee.employee_id)}">Подробнее →</button></div>`).join('') || '<p>Следующие шаги найдены.</p>'}<p>Показаны первые 6; всего ${overview.noSteps.length}.</p></section></div>` : ''}
    <div class="section-head"><h2>Кому может понадобиться поддержка</h2><span>Повторные пропуски важных активностей · алфавитный порядок</span></div>
    <section class="panel table-wrap">${people.length ? `<table><thead><tr><th>Сотрудник</th><th>Карьерная цель</th><th>Связанные навыки</th><th>Пропуски</th><th></th></tr></thead><tbody>${people.map(item => `<tr><td><div class="person-cell"><span class="avatar">${escape(initials(item.state.employee.full_name))}</span><span>${escape(item.state.employee.full_name)}<small>${escape(roleName(item.state.employee.role))} · ${item.state.employee.grade}</small></span></div></td><td>${escape(roleName(item.state.goal.role))}<small>${item.state.goal.grade}${item.state.goal.assumed ? ' · предполагаемая' : ''}</small></td><td>${escape([...new Set(item.misses.map(miss => miss.skill.name))].slice(0, 2).join(', '))}</td><td>${item.importantCount}</td><td><button class="row-button" data-action="hr-person" data-person="${item.state.employee.employee_id}">Подробнее →</button></td></tr>`).join('')}</tbody></table>` : '<p class="subtitle">Повторных пропусков важных активностей нет.</p>'}</section>
    <div class="section-head"><h2>Агрегация по командам</h2><span>Количество, без сравнения эффективности людей</span></div>
    <section class="panel table-wrap"><table><thead><tr><th>Команда</th><th>Сотрудников</th><th>Все пропуски</th><th>Связаны с целью</th></tr></thead><tbody>${overview.departments.map(item => `<tr><td>${escape(item.name)}</td><td>${item.employees}</td><td>${item.misses}</td><td>${item.importantMisses}</td></tr>`).join('')}</tbody></table></section>
    <p class="footnote">Сравнительный рейтинг сотрудников не рассчитывается. Пойнты не используются HR как оценка эффективности. Данные — учебный набор Career Quest.</p>`;
}

function render() {
  const employee = data.employees.find(person => person.employee_id === employeeId) || data.employees[0];
  employeeId = employee.employee_id;
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div><div class="brand"><span class="brand-mark">${icon('chart', 23)}</span>Career Quest</div><div class="workspace">ПРОСТРАНСТВО РАЗВИТИЯ</div></div>
    <nav aria-label="Основные разделы"><p class="nav-label">Рабочее пространство</p><button class="nav-button ${view === 'employee' ? 'active' : ''}" ${view === 'employee' ? 'aria-current="page"' : ''} data-action="employee">${icon('road')}Мой рост</button>
      ${!model.isBackend || data.user.role === 'hr' ? `<button class="nav-button ${view === 'hr' ? 'active' : ''}" ${view === 'hr' ? 'aria-current="page"' : ''} data-action="hr">${icon('team')}Обзор HR</button>` : ''}</nav>
    <div class="sidebar-note"><strong>Демо правил</strong>Навыки и требования взяты из набора Career Quest. Пойнты и шаги внутри API Testing помечены как временные правила.</div>
    <div class="sidebar-bottom"><span class="avatar">${view === 'hr' ? 'HR' : escape(initials(employee.full_name))}</span><div>${view === 'hr' ? 'Режим HR' : escape(employee.full_name.split(' ')[0])}<small>${view === 'hr' ? 'Доступ к аналитике' : employee.grade + ' · личный кабинет'}</small></div></div></aside>
    <main class="main"><header class="topbar"><div class="breadcrumb"><span>Рабочее пространство /</span><strong>${view === 'hr' ? 'Обзор HR' : 'Мой рост'}</strong></div>
      <div class="top-actions"><span class="prototype-badge">Черновой прототип</span><button class="button secondary" data-action="reset">${model.isBackend ? 'Обновить данные' : 'Сбросить демо'}</button>${model.isBackend ? '<button class="button secondary" data-action="logout">Выйти</button>' : ''}</div></header>
      <div class="content">${view === 'hr' ? hrPage() : employeePage(employee)}<p class="footnote">Модельная дата: ${date(data.asOf)} · HackAlem AI</p></div></main></div>`;
}

function openDialog(content) { dialog.innerHTML = content; if (!dialog.open) dialog.showModal(); }
const dialogHead = heading => `<div class="dialog-head"><h2 id="dialog-title">${escape(heading)}</h2><button class="close" data-action="close" aria-label="Закрыть">×</button></div>`;

function showDetails(id) {
  const employee = data.employees.find(person => person.employee_id === employeeId);
  const state = model.snapshot(employee);
  const item = model.recommend(employee).find(row => row.event.event_id === id);
  if (!item) return;
  openDialog(`${dialogHead(title(item.event))}<p>${escape(formats[item.event.format])} · ${item.event.duration_hours} ч · ${item.session ? date(item.session) : 'В любое время'}</p>
    <div class="reason-block"><h3>01 · Навык и его важность</h3><p>${item.impact.map(skill => `${escape(skill.name)}: ${skill.level} → ${skill.after}, для цели нужно ${skill.required}${skill.critical ? ' — ключевой навык' : ''}`).join('<br>')}</p></div>
    <div class="reason-block"><h3>02 · Карьерный эффект</h3><p>Покрытие требований изменится с ${state.coverage}% до ${item.coverageAfter}%. Это вклад в готовность по навыкам, а не обещание повышения.</p></div>
    <div class="reason-block"><h3>03 · Пойнты</h3><p>За следующий шаг: +${item.points}. Награда определена временными правилами проекта; исходный датасет не содержит пойнтов.</p></div>
    <div class="reason-block"><h3>04 · Условия</h3><p>Активность подходит текущей роли и грейду. ${Object.keys(item.event.prerequisites).length ? 'Предварительные требования выполнены.' : 'Предварительных требований нет.'} ${(model.isBackend ? item.repeatAllowed : item.event.event_id === 'EV_036') ? 'Повторное участие разрешено правилами.' : 'Повторное начисление за тот же шаг заблокировано.'}</p></div>
    <div class="dialog-actions"><button class="button" data-action="complete" data-event="${escape(id)}" ${model.isBackend && !item.canComplete ? 'disabled' : ''}>${model.isBackend ? 'Отметить выполнение' : 'Завершить в демо'} ${icon('check', 17)}</button></div>`);
}

async function showHrPerson(id) {
  const employee = model.isBackend ? (await model.hrProfile(id)).employee : data.employees.find(person => person.employee_id === id);
  const state = model.snapshot(employee);
  const misses = model.importantMisses(employee);
  if (!employee) return;
  openDialog(`${dialogHead(employee.full_name)}<p>${escape(roleName(employee.role))} · ${employee.grade}. Цель: ${escape(roleName(state.goal.role))}, ${state.goal.grade}.</p>
    ${misses.map(miss => `<div class="reason-block"><h3>${escape(miss.skill.name)} · ${miss.count} проп.</h3><p>Активность: ${escape(title(miss.event))}. Текущий уровень ${miss.skill.level}, требуется ${miss.skill.required}; не хватает ${miss.skill.gap}. ${miss.nextStep ? `Следующий доступный шаг: ${escape(title(miss.nextStep.event))}.` : 'В текущей подборке нет следующего шага для этого навыка.'}</p></div>`).join('') || '<p>Пропусков, связанных с незакрытыми требованиями цели, нет.</p>'}
    <p>Этот индивидуальный контекст показывается только в HR-разделе.</p>`);
}

function goalDialog() {
  const state = model.snapshot(data.employees.find(person => person.employee_id === employeeId));
  const roleList = [...new Set(data.roleProfiles.map(item => item.role))];
  openDialog(`${dialogHead('Куда вы хотите развиваться?')}<form id="goal-form"><label class="form-field">Роль<select name="role">${roleList.map(role => `<option value="${escape(role)}" ${role === state.goal.role ? 'selected' : ''}>${escape(roleName(role))}</option>`).join('')}</select></label>
    <label class="form-field">Грейд<select name="grade">${GRADES.map(grade => `<option ${grade === state.goal.grade ? 'selected' : ''}>${grade}</option>`).join('')}</select></label>
    <p class="subtitle">Цель пересчитает важность навыков и рекомендации. ${model.isBackend ? 'Выбранная цель будет сохранена.' : 'Исходный профиль останется прежним.'}</p><div class="dialog-actions"><button type="button" class="button secondary" data-action="close">Отмена</button><button type="submit" class="button">Сохранить цель</button></div></form>`);
}

async function action(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const actionName = button.dataset.action;
  if (actionName === 'close') return dialog.close();
  if (actionName === 'details') return showDetails(button.dataset.event);
  if (actionName === 'hr-person') return showHrPerson(button.dataset.person);
  if (actionName === 'catalog') return showCatalog();
  if (actionName === 'logout') { await model.logout(); location.reload(); return; }
  if (actionName === 'goal') return goalDialog();
  if (actionName === 'skills') {
    const state = model.snapshot(data.employees.find(person => person.employee_id === employeeId));
    return openDialog(`${dialogHead('Навыки для вашей цели')}<p>Текущий уровень / требуемый уровень.</p>${state.requirements.map(skillRow).join('')}`);
  }
  if (actionName === 'complete') {
    if (button.disabled) return;
    button.disabled = true;
    let result;
    try { result = await model.complete(employeeId, button.dataset.event, button.dataset.session); }
    finally { button.disabled = false; }
    if (result) {
      dialog.close(); render();
      toast(result.kind === 'session' ? `Сессия ${result.completed} из ${result.total} завершена: +${result.points} пойнт${result.finished ? '. Навык и карьерный прогресс обновлены.' : '. Навык вырастет после всей программы.'}` : `Активность завершена: +${result.points} пойнта. Навыки и цель пересчитаны.`);
    } else toast('Этот шаг уже завершён или сейчас недоступен. Повторного начисления нет.');
    return;
  }
  if (actionName === 'reset') { await model.reset(); if (view === 'hr' && model.isBackend) await model.loadHr(); dialog.close(); render(); toast(model.isBackend ? 'Данные обновлены.' : 'Демо-действия сброшены.'); return; }
  if (actionName === 'hr' && model.isBackend) await model.loadHr();
  view = actionName === 'hr' ? 'hr' : 'employee';
  render(); window.scrollTo({ top: 0, behavior: 'instant' });
}

const onAction = event => action(event).catch(error => toast(error.message));
app.addEventListener('click', onAction);
dialog.addEventListener('click', onAction);
dialog.addEventListener('submit', async event => {
  if (event.target.id !== 'goal-form') return;
  event.preventDefault();
  const form = new FormData(event.target), button = event.target.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    if (await model.setGoal(employeeId, form.get('role'), form.get('grade'))) {
      dialog.close(); render(); toast('Цель сохранена. Рекомендации пересчитаны.');
    }
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

function showCatalog() {
  const items = model.catalog();
  openDialog(`${dialogHead('Активности и сессии')}${items.map(item => `<section class="reason-block"><h3>${escape(title(item.event))}</h3>
    <p>${escape(formats[item.event.format])} · Сессий: ${item.sessionCount} · Повтор: ${item.repeatAllowed ? 'по новой сессии' : 'нет'}</p>
    <p>${item.event.develops_skills.map(g => `${escape(model.skillMap.get(g.skill_id)?.name)}: прирост ${g.gain}, потолок ${g.max_level}`).join('; ') || 'Без прироста навыков'} · Награда: ${item.pointsReward}</p>
    ${item.unavailableReasons.includes('ROLE_NOT_ALLOWED') || item.unavailableReasons.includes('GRADE_NOT_ALLOWED') ? '<p>Не подходит текущей роли или грейду.</p>' : item.unavailableReasons.includes('PREREQUISITES_NOT_MET') ? '<p>Сначала нужно выполнить предварительные требования по навыкам.</p>' : ''}
    <p>Статус участия: ${escape(statusNames[item.status] || item.status)}</p>
    ${item.sessions.map(session => `<div class="metric-row"><span>${escape(session.label)} · ${date(session.date)}<small>${escape(statusNames[session.participationStatus] || session.participationStatus)}${session.date > data.asOf ? ' · запланировано' : ''}</small></span><button class="button secondary" data-action="complete" data-event="${escape(item.event.event_id)}" data-session="${escape(session.session_id)}" ${session.canComplete ? '' : 'disabled'}>Завершить</button></div>`).join('')}
    ${!item.sessions.length ? `<button class="button secondary" data-action="complete" data-event="${escape(item.event.event_id)}" ${item.canComplete ? '' : 'disabled'}>Завершить активность</button>` : ''}
    ${item.program?.historicalCompletion ? '<p>Программа завершена в импортированной истории; даты отдельных исторических сессий неизвестны.</p>' : ''}
  </section>`).join('')}`);
}

try {
  const backend = await connectBackend(app);
  if (backend) { ({ data, demoRules, model, employeeId } = backend); } else {
  const [dataResponse, rulesResponse] = await Promise.all([fetch('./data.json'), fetch('./demo-rules.json')]);
  if (!dataResponse.ok) throw new Error('Нет локального файла данных');
  if (!rulesResponse.ok) throw new Error('Нет файла демонстрационных правил');
  [data, demoRules] = await Promise.all([dataResponse.json(), rulesResponse.json()]);
  if (!data.employees?.length || !data.events?.length || !data.roleProfiles?.length) throw new Error('Неполный набор данных');
  if (demoRules.meta?.kind !== 'demo-only') throw new Error('Файл временных правил не помечен как demo-only');
  model = createModel(data, demoRules);
  }
  render();
} catch (error) {
  app.innerHTML = `<main class="loading"><h1>Не удалось открыть данные</h1><p>Проверьте запуск сервера и обновите страницу.</p><p>${escape(error.message)}</p><a class="button" href="/">Повторить</a></main>`;
}
