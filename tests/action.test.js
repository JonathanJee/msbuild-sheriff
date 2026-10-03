import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const action = fileURLToPath(new URL('../src/action.js', import.meta.url));
const tempRoot = path.join(process.cwd(), '.test-action-tmp');
test.after(() => rmSync(tempRoot, { recursive: true, force: true }));

function workspace(t, project) {
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, 'action-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'main.cpp'), 'int main() { return 0; }\n');
  writeFileSync(path.join(root, 'App.vcxproj'), project);
  return root;
}

function invoke(root, inputs = {}) {
  return spawnSync(process.execPath, [action], {
    cwd: path.dirname(root),
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKSPACE: root,
      INPUT_PATH: inputs.path ?? 'App.vcxproj',
      INPUT_FORMAT: inputs.format ?? 'text',
      INPUT_SEVERITY: inputs.severity ?? 'info',
    },
  });
}

const project = (items) => `<Project><PropertyGroup><ProjectGuid>{11111111-1111-1111-1111-111111111111}</ProjectGuid></PropertyGroup><ItemGroup Label="ProjectConfigurations"><ProjectConfiguration Include="Debug|x64" /></ItemGroup><ItemGroup>${items}</ItemGroup></Project>`;

test('GitHub Action uses workspace-relative paths and succeeds on a healthy project', (t) => {
  const root = workspace(t, project('<ClCompile Include="main.cpp" />'));
  const result = invoke(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No findings\./);
  assert.match(result.stdout, /^::stop-commands::([\w-]+)\n[\s\S]*\n::\1::\n$/);
});

test('GitHub Action preserves findings, severity, and invalid-input exit codes', (t) => {
  const root = workspace(t, project('<ClCompile Include="main.cpp" /><ClCompile Include="main.cpp" />'));
  const warning = invoke(root, { format: 'json' });
  assert.equal(warning.status, 1, warning.stdout + warning.stderr);
  assert.match(warning.stdout, /MSB007/);

  const filtered = invoke(root, { severity: 'error' });
  assert.equal(filtered.status, 0, filtered.stdout + filtered.stderr);
  assert.match(filtered.stdout, /No findings\./);

  writeFileSync(path.join(tempRoot, 'outside.vcxproj'), project('<ClCompile Include="main.cpp" />'));
  const invalid = invoke(root, { path: '../outside.vcxproj' });
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout, /inside GITHUB_WORKSPACE/);
});

test('GitHub Action rejects a directory symlink that escapes the workspace', (t) => {
  const root = workspace(t, project('<ClCompile Include="main.cpp" />'));
  const external = mkdtempSync(path.join(tempRoot, 'external-'));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(path.join(external, 'Outside.vcxproj'), project('<ClCompile Include="main.cpp" />'));
  try {
    symlinkSync(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('Creating directory links is not permitted');
    throw error;
  }
  const result = invoke(root, { path: 'linked/Outside.vcxproj' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /inside GITHUB_WORKSPACE/);
});

test('GitHub Action disables workflow-command parsing around project text', (t) => {
  const root = workspace(t, project('<ClCompile Include="missing\n::warning::injected" />'));
  const result = invoke(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const match = result.stdout.match(/^::stop-commands::([\w-]+)\n([\s\S]*)\n::\1::\n$/);
  assert.ok(match, result.stdout);
  assert.match(match[2], /::warning::injected/);
});

test('GitHub Action fails closed when the runner workspace is missing', () => {
  const result = spawnSync(process.execPath, [action], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: '', INPUT_PATH: '.' },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /GITHUB_WORKSPACE is required/);
});
