import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend } from '../src/backend/server.mjs';

// Intentionally public demo credentials, restricted to a separate synthetic dataset/database.
const root = fileURLToPath(new URL('../', import.meta.url));
Object.assign(process.env, {
  CQ_EMPLOYEE_TOKEN: 'employee-demo',
  CQ_HR_TOKEN: 'hr-demo',
  CQ_EMPLOYEE_ID: 'E0066',
  CQ_DATASET: resolve(root, 'src/prototype/data.json'),
  CQ_DB_PATH: resolve(root, '.local/team-demo.sqlite'),
  CQ_AS_OF: '2026-10-01',
  AI_ENABLED: 'false',
});
console.log('Demo login: employee-demo (employee), hr-demo (HR). Synthetic data only.');
startBackend();
