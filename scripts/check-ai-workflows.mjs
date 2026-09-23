import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configReader, ROOT } from './serve.mjs';
import { createStructuredProvider, configurationStatus } from './ai/provider.mjs';
import { createRecommender, buildContext } from './ai/recommender.mjs';
import { createWorkflows } from './ai/workflows.mjs';
import { cases } from '../tests/fixtures/recommendation-cases.mjs';

// Exactly three sequential model calls in --live mode, with wholly invented data.
// Never load organizer profiles or imported jury files in this check.
const live = process.argv.includes('--live'), config = configReader()();
const ready = configurationStatus(config).ready;
const provider = createStructuredProvider({ config: live ? config : { ...config, enabled: false } });
const sample = structuredClone(cases.find(c => c.id === 'missing-prerequisite').data);
const recommendations = createRecommender({ provider }), workflows = createWorkflows({ data: sample, provider });
const input = { employeeId: 'SYNTHETIC', simulated: [] };
const checks = [
  { name: 'recommendations', run: () => recommendations.run(buildContext(sample, input)), valid: r => r.recommendations.length > 0 && r.recommendations.every(x => x.event_id === 'FOUNDATION') },
  { name: 'development-plan', run: () => workflows.developmentPlan({ ...input, options: { maxSteps: 3, weeklyHours: 4 } }), valid: r => r.plan?.steps[0]?.event_id === 'FOUNDATION' && r.plan.steps.every((s, i) => s.event_id === (i === 0 ? 'FOUNDATION' : 'ADVANCED')) },
  { name: 'hr-activity', run: () => workflows.improveActivity({ eventId: 'ADVANCED', brief: 'Добавить практику и измеримую проверку навыка.', progress: [] }), valid: r => r.draft?.improvements.length >= 2 && r.draft.agenda.reduce((n, s) => n + s.minutes, 0) <= 240 },
];
const report = { generatedAt: new Date().toISOString(), mode: live ? ready ? 'live' : 'live-blocked' : 'offline', model: config.model,
  data: 'invented fixture only', liveVerified: false, checks: [],
  limitation: 'Three smoke checks establish connectivity and output validity, not better career outcomes. Free-text claims require manual review. Offline checks do not test the model.' };
if (live && !ready) report.blocker = configurationStatus(config).message;
else for (const check of checks) {
  const start = performance.now(), result = await check.run();
  const elapsedMs = Math.round(performance.now() - start), outputValid = Boolean(check.valid(result));
  report.checks.push({ scenario: check.name, source: result.source, elapsedMs, outputValid,
    passed: outputValid && (!live || (result.source === 'ai' && elapsedMs < 10_000)), result });
}
report.liveVerified = live && report.checks.length === 3 && report.checks.every(c => c.passed);
const folder = resolve(ROOT, 'artifacts'); mkdirSync(folder, { recursive: true });
const file = resolve(folder, live ? 'ai-workflows-live.json' : 'ai-workflows-offline.json');
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ mode: report.mode, liveVerified: report.liveVerified, blocker: report.blocker,
  checks: report.checks.map(({ result, ...summary }) => summary), report: file }, null, 2));
if (report.blocker || report.checks.some(c => !c.passed)) process.exitCode = 1;
