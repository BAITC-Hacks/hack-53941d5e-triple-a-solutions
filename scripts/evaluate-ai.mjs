import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadLocalEnv } from './serve.mjs';
import { buildContext, createRecommender, readConfig, configurationStatus, PROMPT_VERSION } from './ai/recommender.mjs';
import { cases } from '../tests/fixtures/recommendation-cases.mjs';

loadLocalEnv();
const live = process.argv.includes('--live');
const config = readConfig();
if (live && !configurationStatus(config).ready) {
  console.error(`Live comparison cannot run: ${configurationStatus(config).message}`);
  process.exit(1);
}
const service = createRecommender({ config });
const dataset = JSON.parse(readFileSync(resolve(ROOT, 'src/prototype/data.json'), 'utf8'));
const datasetCoverage = dataset.employees.map(person => buildContext(dataset, { employeeId: person.employee_id }).candidates.length);
const report = {
  generatedAt: new Date().toISOString(), mode: live ? 'live' : 'offline-baseline-only',
  model: live ? config.model : null, promptVersion: PROMPT_VERSION,
  limitation: 'Expected choices are product hypotheses on invented cases. Proxy metrics do not establish real development outcomes. Free-text explanations require human review. No AI improvement can be claimed without a live comparison.',
  dataset: { profiles: datasetCoverage.length, withCandidates: datasetCoverage.filter(n => n > 0).length, withoutCandidates: datasetCoverage.filter(n => n === 0).length },
  cases: [],
};
function metrics(ids, ctx, expected) {
  const candidates = ids.map(id => ctx.candidates.find(c => c.event.event_id === id));
  const total = ctx.state.requirements.reduce((sum, s) => sum + s.required, 0);
  const first = candidates[0];
  return {
    valid: candidates.every(Boolean),
    matchesScenario: expected.length ? expected.includes(ids[0]) : ids.length === 0,
    firstStepCoverageGainPp: first && total ? Number((first.impact.reduce((sum, s) => sum + s.reduction, 0) / total * 100).toFixed(2)) : 0,
    firstStepCriticalGain: first?.impact.filter(s => s.critical).reduce((sum, s) => sum + s.reduction, 0) || 0,
    firstStepHours: first?.event.duration_hours || 0,
    firstStepFormatSetbacks: first?.setbacks || 0,
  };
}
for (const item of cases) {
  const ctx = buildContext(item.data, { employeeId: 'SYNTHETIC' });
  const ids = ctx.candidates.slice(0, 3).map(c => c.event.event_id);
  const row = { id: item.id, description: item.description, expectedFirst: item.expectedFirst,
    baseline: { ids, metrics: metrics(ids, ctx, item.expectedFirst) }, ai: null };
  if (live) {
    const result = await service.run(ctx);
    const aiIds = result.recommendations.map(r => r.event_id);
    row.ai = { source: result.source, ids: aiIds, elapsedMs: result.elapsedMs, message: result.message,
      recommendations: result.recommendations,
      metrics: result.source === 'ai' || !ctx.candidates.length ? metrics(aiIds, ctx, item.expectedFirst) : null };
  }
  report.cases.push(row);
}
const comparable = report.cases.filter(row => row.ai?.source === 'ai');
report.summary = {
  baselineMatches: report.cases.filter(row => row.baseline.metrics.matchesScenario).length,
  totalScenarios: cases.length,
  liveAiResponses: comparable.length,
  liveFailures: report.cases.filter(row => row.ai && row.baseline.ids.length && row.ai.source !== 'ai').length,
  improvedScenarios: comparable.filter(row => !row.baseline.metrics.matchesScenario && row.ai.metrics.matchesScenario).length,
  regressedScenarios: comparable.filter(row => row.baseline.metrics.matchesScenario && !row.ai.metrics.matchesScenario).length,
  conclusion: !live ? 'AI not evaluated: no external requests were made.' : 'Compare paired cases and inspect explanations. A changed ranking alone is not evidence of improvement.',
};
const outputDir = resolve(ROOT, 'artifacts');
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'ai-evaluation.json'), JSON.stringify(report, null, 2) + '\n');
const md = [
  '# Сравнение рекомендаций Career Quest', '',
  `Режим: **${live ? 'реальные вызовы модели' : 'только исходный алгоритм; AI не вызывался'}**.`,
  `Исходный алгоритм совпал с ожидаемым первым шагом в ${report.summary.baselineMatches} из ${cases.length} сценариев.`,
  '', '| Сценарий | Первый шаг по правилам | Ожидаемый шаг | Первый шаг AI |', '|---|---|---|---|',
  ...report.cases.map(row => `| ${row.description} | ${row.baseline.ids[0] || 'Нет'} | ${row.expectedFirst.join(' / ') || 'Нет'} | ${row.ai ? (row.ai.source === 'ai' ? row.ai.ids[0] : 'Подбор по правилам') : 'Не проверен'} |`),
  '', 'Ожидания заданы нами на семи искусственных сценариях, а не получены от жюри. Это малая проверка выбора, не измерение реального развития сотрудников.',
  'В JSON отдельно сохранены прирост покрытия требований, критичных навыков, длительность, история формата и время ответа. Не сводите качество к одной из этих метрик.',
  'Свободный текст AI требует проверки человеком: ссылки на факты не гарантируют правильность каждого утверждения.',
  `На исходном датасете кандидаты есть у ${report.dataset.withCandidates} из ${report.dataset.profiles} сотрудников. Эти данные не отправлялись модели этим скриптом.`,
  '', live ? `Ответов AI: ${report.summary.liveAiResponses}; ошибок с возвратом к правилам: ${report.summary.liveFailures}; улучшений по ожидаемому выбору: ${report.summary.improvedScenarios}; ухудшений: ${report.summary.regressedScenarios}.` : '**Улучшение от AI пока не измерено.** Для этого нужен разрешённый endpoint и реальный запуск с `--live`.',
];
writeFileSync(resolve(outputDir, 'ai-evaluation.md'), md.join('\n') + '\n');
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Report: ${resolve(outputDir, 'ai-evaluation.md')}`);
