import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkAdminScript } from './admin-script-harness.js';

test('deployed admin bundle boots, signs in and switches workbench tabs', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const outdir = path.join(root, '.wrangler', 'admin-bundle-check');
  execFileSync(process.execPath, [
    path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'deploy', '--dry-run', '--config', 'wrangler-admin.jsonc', '--outdir', outdir,
  ], { cwd: root, encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
  const { default: worker } = await import(pathToFileURL(path.join(outdir, 'admin-worker.js')));
  const response = await worker.fetch(new Request('https://fixture.invalid/'), {});
  await checkAdminScript(await response.text());
});
