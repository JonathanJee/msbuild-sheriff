import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { run } from './cli.js';

const inActions = process.env.GITHUB_ACTIONS === 'true';
const token = inActions ? randomUUID() : null;
if (token) process.stdout.write(`::stop-commands::${token}\n`);

try {
  if (inActions && !process.env.GITHUB_WORKSPACE) throw new Error('GITHUB_WORKSPACE is required');
  const workspace = realpathSync(process.env.GITHUB_WORKSPACE || process.cwd());
  const input = process.env.INPUT_PATH || '.';
  const target = realpathSync(path.resolve(workspace, input));
  const relative = path.relative(workspace, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Scan path must stay inside GITHUB_WORKSPACE');
  }
  process.chdir(workspace);
  process.exitCode = await run([
    'scan', input,
    '--format', process.env.INPUT_FORMAT || 'text',
    '--severity', process.env.INPUT_SEVERITY || 'info',
  ], inActions ? { stdout: process.stdout, stderr: process.stdout } : undefined);
} catch (error) {
  (inActions ? process.stdout : process.stderr).write(`${error.message}\n`);
  process.exitCode = 2;
} finally {
  if (token) process.stdout.write(`::${token}::\n`);
}
