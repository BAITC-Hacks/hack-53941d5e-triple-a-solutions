import { contextFromFacts, createRecommender } from '../../scripts/ai/recommender.mjs';
import { createStructuredProvider, readConfig } from '../../scripts/ai/provider.mjs';
import { createWorkflows } from '../../scripts/ai/workflows.mjs';
import { buildDevelopmentPaths, activityContext } from '../prototype/development.mjs';

export function workflowService(service, provider = createStructuredProvider({ config: readConfig(process.env) })) {
  const { employees, history } = service.context();
  const data = { ...service.data, employees, history, asOf: service.asOf };
  function context(id) {
    const state = service.profile(id);
    const ctx = contextFromFacts(data, state, service.recommendations(id).recommendations);
    ctx.explanationOnly = true;
    ctx.payload.candidates.sort((a, b) => ctx.candidates.findIndex(c => c.event.event_id === a.event_id) - ctx.candidates.findIndex(c => c.event.event_id === b.event_id));
    return ctx;
  }
  return {
    status: provider.status,
    recommendations: id => createRecommender({ provider }).run(context(id)),
    contexts: () => data.events.filter(e => !e.mandatory).map(e => activityContext(data, e.event_id)),
    improveActivity: input => createWorkflows({ data, provider }).improveActivity(input),
    developmentPlan(id, options) {
      const ctx = context(id), current = ctx.state;
      // Projection starts at persisted levels, never replays gains from old history.
      const person = employees.find(e => e.employee_id === id);
      const catalog = new Map(service.catalog(id).map(c => [c.event.event_id, c]));
      const subset = { ...data, employees: [person], history: history.filter(h => h.employee_id === id),
        events: data.events.filter(e => !current.done.includes(e.event_id)).map(event => {
          const program = catalog.get(event.event_id)?.program;
          return program ? { ...event, upcoming_sessions: program.sessions.filter(s => !s.completed).map(s => s.date) } : event;
        }) };
      const projected = { ...current, employee: person, simulated: [] };
      return createWorkflows({ data, provider, preparedContext: ctx, preparedPaths: settings => {
        const paths = buildDevelopmentPaths(subset, projected, settings, service.rules);
        return paths.slice(0, 1).map(path => ({ ...path, baseDone: current.done }));
      } }).developmentPlan({ employeeId: id, options });
    },
  };
}
