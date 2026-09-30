import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { formatJson, formatSarif, scan } from '../src/index.js';

const GUID_APP = '11111111-1111-1111-1111-111111111111';
const GUID_LIB = '22222222-2222-2222-2222-222222222222';
const TEST_TEMP_ROOT = join(process.cwd(), '.test-tmp');

test.after(() => rmSync(TEST_TEMP_ROOT, { recursive: true, force: true }));

function makeWorkspace(t) {
  mkdirSync(TEST_TEMP_ROOT, { recursive: true });
  const directory = mkdtempSync(join(TEST_TEMP_ROOT, 'msbuild-sheriff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    write(relativePath, contents = '') {
      const target = join(directory, relativePath);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents, 'utf8');
      return target;
    },
  };
}

function vcxproj({
  guid = GUID_APP,
  configuration = 'Debug|x64',
  items = '<ClCompile Include="main.cpp" />',
  imports = '',
  references = '',
  properties = '',
} = {}) {
  const guidElement = guid === null ? '' : `<ProjectGuid>{${guid}}</ProjectGuid>`;
  return `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="${configuration}" />
  </ItemGroup>
  <PropertyGroup Label="Globals">${guidElement}</PropertyGroup>
  ${properties}
  ${imports}
  <ItemGroup>${items}</ItemGroup>
  <ItemGroup>${references}</ItemGroup>
</Project>`;
}

function solution({ mapping = 'Debug|x64', includeLib = false } = {}) {
  const lib = includeLib
    ? `Project("{BC8A1FFA-BEE3-4634-8014-F334798102B3}") = "Lib", "Lib.vcxproj", "{${GUID_LIB}}"\nEndProject\n`
    : '';
  return `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{BC8A1FFA-BEE3-4634-8014-F334798102B3}") = "App", "App.vcxproj", "{${GUID_APP}}"
EndProject
${lib}Global
  GlobalSection(ProjectConfigurationPlatforms) = postSolution
    {${GUID_APP}}.Debug|x64.ActiveCfg = ${mapping}
    {${GUID_APP}}.Debug|x64.Build.0 = ${mapping}
  EndGlobalSection
EndGlobal
`;
}

function diagnosticIds(result) {
  return new Set(result.diagnostics.map((diagnostic) => diagnostic.ruleId));
}

function memoryStream() {
  let value = '';
  return {
    write(chunk) { value += String(chunk); },
    read() { return value; },
  };
}

test('healthy solution, project, and directory scans produce no diagnostics', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const project = workspace.write('App.vcxproj', vcxproj());
  const sln = workspace.write('App.sln', solution());

  for (const target of [workspace.directory, project, sln]) {
    const result = await scan(target);
    assert.deepEqual(result.diagnostics, []);
  }
});

test('MSB001 reports missing and cross-project duplicate ProjectGuid values', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('MissingGuid.vcxproj', vcxproj({ guid: null }));
  workspace.write('First.vcxproj', vcxproj());
  workspace.write('Second.vcxproj', vcxproj());

  const result = await scan(workspace.directory);
  assert.ok(result.diagnostics.filter((item) => item.ruleId === 'MSB001').length >= 3);
});

test('MSB002 reports missing targets, GUID drift, and solution membership', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('lib.cpp');
  workspace.write('outside.cpp');
  workspace.write('Lib.vcxproj', vcxproj({ guid: GUID_LIB, items: '<ClCompile Include="lib.cpp" />' }));
  workspace.write('Outside.vcxproj', vcxproj({ guid: '33333333-3333-3333-3333-333333333333', items: '<ClCompile Include="outside.cpp" />' }));
  workspace.write('App.vcxproj', vcxproj({ references: `
    <ProjectReference Include="Missing.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>
    <ProjectReference Include="Lib.vcxproj"><Project>{${GUID_APP}}</Project></ProjectReference>
    <ProjectReference Include="Outside.vcxproj"><Project>{33333333-3333-3333-3333-333333333333}</Project></ProjectReference>` }));
  const sln = workspace.write('App.sln', solution({ includeLib: true }));

  const result = await scan(sln);
  const messages = result.diagnostics.filter((item) => item.ruleId === 'MSB002').map((item) => item.message).join('\n');
  assert.match(messages, /does not exist/i);
  assert.match(messages, /does not match/i);
  assert.match(messages, /not a member/i);
});

test('MSB003 reports a solution mapping absent from the project', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('App.vcxproj', vcxproj());
  const sln = workspace.write('App.sln', solution({ mapping: 'Release|Win32' }));
  assert.ok(diagnosticIds(await scan(sln)).has('MSB003'));
});

test('MSB004 and MSB005 report resolvable missing imports and items', async (t) => {
  const workspace = makeWorkspace(t);
  const project = workspace.write('App.vcxproj', vcxproj({
    imports: '<Import Project="$(ProjectDir)missing.targets" />',
    items: '<ClCompile Include="missing.cpp" />',
  }));
  const ids = diagnosticIds(await scan(project));
  assert.ok(ids.has('MSB004'));
  assert.ok(ids.has('MSB005'));
});

test('MSB006 and MSB007 report absolute build paths and duplicate items', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const absoluteInclude = join(workspace.directory, 'vendor', 'include');
  const project = workspace.write('App.vcxproj', vcxproj({
    items: '<ClCompile Include="main.cpp" /><ClCompile Include="main.cpp" />',
    properties: `<ItemDefinitionGroup><ClCompile><AdditionalIncludeDirectories>${absoluteInclude}</AdditionalIncludeDirectories></ClCompile></ItemDefinitionGroup>`,
  }));
  const ids = diagnosticIds(await scan(project));
  assert.ok(ids.has('MSB006'));
  assert.ok(ids.has('MSB007'));
});

test('unknown properties and conditioned imports are skipped conservatively', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const project = workspace.write('App.vcxproj', vcxproj({ imports: `
    <Import Project="$(UnknownSdkRoot)\\custom.targets" />
    <Import Project="missing.targets" Condition="Exists('missing.targets')" />` }));
  const result = await scan(project);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB004'), false);
});

test('JSON and SARIF output are valid and preserve rule identifiers', async (t) => {
  const workspace = makeWorkspace(t);
  const project = workspace.write('App.vcxproj', vcxproj({ items: '<ClCompile Include="missing.cpp" />' }));
  const diagnostics = (await scan(project)).diagnostics;
  const json = JSON.parse(formatJson(diagnostics));
  assert.ok(json.some((item) => item.ruleId === 'MSB005'));
  const sarif = JSON.parse(formatSarif(diagnostics));
  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.runs[0].results.some((item) => item.ruleId === 'MSB005'));
});

test('CLI run returns 0, 1, and 2 and honors the severity threshold', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const warningOnly = workspace.write('App.vcxproj', vcxproj({
    items: '<ClCompile Include="main.cpp" /><ClCompile Include="main.cpp" />',
  }));
  let stdout = memoryStream();
  let stderr = memoryStream();
  assert.equal(await run(['scan', warningOnly, '--severity', 'error'], { stdout, stderr }), 0);
  assert.match(stdout.read(), /No findings/);

  stdout = memoryStream();
  stderr = memoryStream();
  assert.equal(await run(['scan', warningOnly, '--format', 'json'], { stdout, stderr }), 1);
  assert.match(stdout.read(), /MSB007/);

  stdout = memoryStream();
  stderr = memoryStream();
  assert.equal(await run(['scan', 'does-not-exist'], { stdout, stderr }), 2);
  assert.match(stderr.read(), /Path does not exist/);

  stdout = memoryStream();
  stderr = memoryStream();
  assert.equal(await run(['unknown'], { stdout, stderr }), 2);
  assert.match(stderr.read(), /Usage/);
});

test('SolutionDir project references resolve with solution context', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('lib.cpp');
  workspace.write('Lib.vcxproj', vcxproj({ guid: GUID_LIB, items: '<ClCompile Include="lib.cpp" />' }));
  workspace.write('App.vcxproj', vcxproj({
    references: `<ProjectReference Include="$(SolutionDir)\\Lib.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>`,
  }));
  const sln = workspace.write('App.sln', solution({ includeLib: true }));
  const result = await scan(sln);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB002'), false);
});

test('missing solution members and solution/project GUID drift report MSB002', async (t) => {
  const missing = makeWorkspace(t);
  const missingSln = missing.write('Missing.sln', solution());
  assert.ok(diagnosticIds(await scan(missingSln)).has('MSB002'));

  const drift = makeWorkspace(t);
  drift.write('main.cpp');
  drift.write('App.vcxproj', vcxproj({ guid: GUID_LIB }));
  const driftSln = drift.write('Drift.sln', solution());
  const messages = (await scan(driftSln)).diagnostics.filter((item) => item.ruleId === 'MSB002').map((item) => item.message).join('\n');
  assert.match(messages, /GUID/i);
});

test('MSB001 reports only the GUID value that is actually repeated', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const unique = '33333333-3333-3333-3333-333333333333';
  const project = workspace.write('App.vcxproj', vcxproj({
    properties: `<PropertyGroup><ProjectGuid>{${GUID_APP}}</ProjectGuid><ProjectGuid>{${unique}}</ProjectGuid></PropertyGroup>`,
  }));
  const messages = (await scan(project)).diagnostics.filter((item) => item.ruleId === 'MSB001').map((item) => item.message).join('\n');
  assert.match(messages, new RegExp(GUID_APP, 'i'));
  assert.doesNotMatch(messages, new RegExp(unique, 'i'));
});

test('wildcard and conditioned imports do not produce existence errors', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const project = workspace.write('App.vcxproj', vcxproj({ imports: `
    <Import Project="props\\*.props" />
    <Import Project="missing.targets" Condition="'$(Configuration)' &gt; 'A'" />` }));
  const result = await scan(project);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB004'), false);
});

test('MSBuild backslashes after ProjectDir resolve on every host platform', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('build/common.props');
  const project = workspace.write('App.vcxproj', vcxproj({
    imports: '<Import Project="$(ProjectDir)\\build\\common.props" />',
  }));
  const result = await scan(project);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB004'), false);
});

test('mutually conditioned duplicate items and item expressions are not guessed', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const project = workspace.write('App.vcxproj', `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
    <ItemGroup Label="ProjectConfigurations"><ProjectConfiguration Include="Debug|x64" /></ItemGroup>
    <PropertyGroup><ProjectGuid>{${GUID_APP}}</ProjectGuid></PropertyGroup>
    <ItemGroup Condition="'$(Configuration)' == 'Debug'"><ClCompile Include="main.cpp" /></ItemGroup>
    <ItemGroup Condition="'$(Configuration)' == 'Release'"><ClCompile Include="main.cpp" /></ItemGroup>
    <ItemGroup><ClCompile Include="@(GeneratedSources)" /></ItemGroup>
  </Project>`);
  const result = await scan(project);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB007'), false);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB005' && item.message.includes('@(')), false);
});

test('external, absolute, and UNC paths are reported without missing-file probes', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('.git/keep');
  const project = workspace.write('App.vcxproj', vcxproj({ items: `
    <ClCompile Include="..\\outside.cpp" />
    <ClInclude Include="C:\\private\\secret.h" />
    <ResourceCompile Include="\\\\unreachable-host\\share\\file.rc" />`,
    properties: '<ItemDefinitionGroup><ClCompile><AdditionalIncludeDirectories>C:\\SDK\\$(Configuration)</AdditionalIncludeDirectories></ClCompile></ItemDefinitionGroup>',
  }));
  const result = await scan(project);
  assert.ok(result.diagnostics.filter((item) => item.ruleId === 'MSB006').length >= 4);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB005'), false);
});

test('SARIF uses repository-relative URIs and not raw Windows paths', () => {
  const file = join(process.cwd(), 'src', 'index.js');
  const sarif = JSON.parse(formatSarif([{
    ruleId: 'MSB005', severity: 'error', message: 'example', file, line: 1, column: 1,
  }]));
  const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
  assert.equal(uri, 'src/index.js');
  assert.doesNotMatch(uri, /^[A-Za-z]:/);
});

test('SARIF percent-encodes URI delimiters in repository file names', () => {
  const file = join(process.cwd(), 'fixtures', 'name#with?delimiters.vcxproj');
  const sarif = JSON.parse(formatSarif([{
    ruleId: 'MSB005', severity: 'error', message: 'example', file, line: 1, column: 1,
  }]));
  const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
  assert.equal(uri, 'fixtures/name%23with%3Fdelimiters.vcxproj');
});

test('SolutionDir references outside solution membership still report MSB002', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('outside.cpp');
  workspace.write('Outside.vcxproj', vcxproj({ guid: GUID_LIB, items: '<ClCompile Include="outside.cpp" />' }));
  workspace.write('App.vcxproj', vcxproj({
    references: `<ProjectReference Include="$(SolutionDir)\\Outside.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>`,
  }));
  const sln = workspace.write('App.sln', solution());
  const messages = (await scan(sln)).diagnostics.filter((item) => item.ruleId === 'MSB002').map((item) => item.message).join('\n');
  assert.match(messages, /not a member/i);
});

test('ancestor conditions on ImportGroup and ProjectReference suppress speculative checks', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const project = workspace.write('App.vcxproj', `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
    <ItemGroup Label="ProjectConfigurations"><ProjectConfiguration Include="Debug|x64" /></ItemGroup>
    <PropertyGroup><ProjectGuid>{${GUID_APP}}</ProjectGuid></PropertyGroup>
    <ImportGroup Condition="'$(Configuration)' == 'Release'"><Import Project="missing.props" /></ImportGroup>
    <ItemGroup><ClCompile Include="main.cpp" /></ItemGroup>
    <ItemGroup><ProjectReference Include="missing.vcxproj" Condition="Exists('missing.vcxproj')" /></ItemGroup>
  </Project>`);
  const ids = diagnosticIds(await scan(project));
  assert.equal(ids.has('MSB004'), false);
  assert.equal(ids.has('MSB002'), false);
});

test('Choose branches keep duplicate items in distinct conditional scopes', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const project = workspace.write('App.vcxproj', `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
    <ItemGroup Label="ProjectConfigurations"><ProjectConfiguration Include="Debug|x64" /></ItemGroup>
    <PropertyGroup><ProjectGuid>{${GUID_APP}}</ProjectGuid></PropertyGroup>
    <Choose>
      <When Condition="'$(Configuration)' == 'Debug'"><ItemGroup><ClCompile Include="main.cpp" /></ItemGroup></When>
      <Otherwise><ItemGroup><ClCompile Include="main.cpp" /></ItemGroup></Otherwise>
    </Choose>
  </Project>`);
  assert.equal((await scan(project)).diagnostics.some((item) => item.ruleId === 'MSB007'), false);
});

test('SolutionDir source items are checked with solution context', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('App.vcxproj', vcxproj({ items: '<ClCompile Include="$(SolutionDir)\\missing.cpp" />' }));
  const sln = workspace.write('App.sln', solution());
  assert.ok(diagnosticIds(await scan(sln)).has('MSB005'));
});

test('metadata expressions remain unresolved instead of becoming missing files', async (t) => {
  const workspace = makeWorkspace(t);
  const project = workspace.write('App.vcxproj', vcxproj({ items: '<ClCompile Include="generated\\%(Filename).cpp" />' }));
  assert.equal((await scan(project)).diagnostics.some((item) => item.ruleId === 'MSB005'), false);
});

test('absolute ProjectReference paths report MSB006 without probing', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  const project = workspace.write('App.vcxproj', vcxproj({
    references: '<ProjectReference Include="C:\\private\\Lib.vcxproj" />',
  }));
  assert.ok(diagnosticIds(await scan(project)).has('MSB006'));
});

test('single-project scans use the git repository as the safe sibling boundary', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('.git/keep');
  workspace.write('app/main.cpp');
  workspace.write('lib/lib.cpp');
  workspace.write('lib/Lib.vcxproj', vcxproj({ guid: GUID_LIB, items: '<ClCompile Include="lib.cpp" />' }));
  const project = workspace.write('app/App.vcxproj', vcxproj({
    items: '<ClCompile Include="main.cpp" />',
    references: `<ProjectReference Include="..\\lib\\Lib.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>`,
  }));
  const result = await scan(project);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB006'), false);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB002'), false);
});

test('SolutionDir out-of-solution targets are loaded for GUID validation', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('outside.cpp');
  workspace.write('Outside.vcxproj', vcxproj({ guid: GUID_LIB, items: '<ClCompile Include="outside.cpp" />' }));
  workspace.write('App.vcxproj', vcxproj({
    references: `<ProjectReference Include="$(solutiondir)\\Outside.vcxproj"><Project>{${GUID_APP}}</Project></ProjectReference>`,
  }));
  const sln = workspace.write('App.sln', solution());
  const messages = (await scan(sln)).diagnostics.filter((item) => item.ruleId === 'MSB002').map((item) => item.message).join('\n');
  assert.match(messages, /not a member/i);
  assert.match(messages, /does not match/i);
});

test('semicolon ProjectReference lists are checked while wildcard references stay conservative', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('lib.cpp');
  workspace.write('Lib.vcxproj', vcxproj({ guid: GUID_LIB, items: '<ClCompile Include="lib.cpp" />' }));
  const project = workspace.write('App.vcxproj', vcxproj({
    references: `
      <ProjectReference Include="Lib.vcxproj;Missing.vcxproj" />
      <ProjectReference Include="generated\\*.vcxproj" />`,
  }));
  const messages = (await scan(project)).diagnostics.filter((item) => item.ruleId === 'MSB002').map((item) => item.message).join('\n');
  assert.match(messages, /does not exist: Missing\.vcxproj/i);
  assert.doesNotMatch(messages, /generated/i);
});

test('dynamically loaded references inherit the solution context for their own paths', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('outside.cpp');
  workspace.write('Outside.vcxproj', vcxproj({
    guid: GUID_LIB,
    items: '<ClCompile Include="outside.cpp" />',
    imports: '<Import Project="$(SolutionDir)\\missing.props" />',
  }));
  workspace.write('App.vcxproj', vcxproj({
    references: `<ProjectReference Include="$(SolutionDir)\\Outside.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>`,
  }));
  const sln = workspace.write('App.sln', solution());
  assert.ok(diagnosticIds(await scan(sln)).has('MSB004'));
});

test('directory scans use the git repository as the safe sibling boundary', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('.git/keep');
  workspace.write('app/main.cpp');
  workspace.write('lib/lib.cpp');
  workspace.write('lib/Lib.vcxproj', vcxproj({ guid: GUID_LIB, items: '<ClCompile Include="lib.cpp" />' }));
  workspace.write('app/App.vcxproj', vcxproj({
    items: '<ClCompile Include="main.cpp" />',
    references: `<ProjectReference Include="..\\lib\\Lib.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>`,
  }));
  const result = await scan(join(workspace.directory, 'app'));
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB006'), false);
  assert.equal(result.diagnostics.some((item) => item.ruleId === 'MSB002'), false);
});

test('a ProjectReference that resolves to a directory is reported instead of crashing', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  mkdirSync(join(workspace.directory, 'Directory.vcxproj'));
  const project = workspace.write('App.vcxproj', vcxproj({
    references: '<ProjectReference Include="Directory.vcxproj" />',
  }));
  const messages = (await scan(project)).diagnostics.filter((item) => item.ruleId === 'MSB002').map((item) => item.message).join('\n');
  assert.match(messages, /does not exist/i);
});

test('directory scans propagate solution context to a target that was preloaded first', async (t) => {
  const workspace = makeWorkspace(t);
  workspace.write('main.cpp');
  workspace.write('outside.cpp');
  workspace.write('AOutside.vcxproj', vcxproj({
    guid: GUID_LIB,
    items: '<ClCompile Include="outside.cpp" />',
    imports: '<Import Project="$(SolutionDir)\\missing.props" />',
  }));
  workspace.write('ZApp.vcxproj', vcxproj({
    references: `<ProjectReference Include="$(SolutionDir)\\AOutside.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>`,
  }));
  workspace.write('App.sln', solution().replace('App.vcxproj', 'ZApp.vcxproj'));
  assert.ok(diagnosticIds(await scan(workspace.directory)).has('MSB004'));
});

test('solution context propagates through a preloaded reference cycle', async (t) => {
  const workspace = makeWorkspace(t);
  const guidC = '33333333-3333-3333-3333-333333333333';
  workspace.write('main.cpp');
  workspace.write('b.cpp');
  workspace.write('c.cpp');
  workspace.write('B.vcxproj', vcxproj({
    guid: GUID_LIB,
    items: '<ClCompile Include="b.cpp" />',
    references: `<ProjectReference Include="$(SolutionDir)\\C.vcxproj"><Project>{${guidC}}</Project></ProjectReference>`,
  }));
  workspace.write('C.vcxproj', vcxproj({
    guid: guidC,
    items: '<ClCompile Include="c.cpp" />',
    imports: '<Import Project="$(SolutionDir)\\missing.props" />',
    references: `<ProjectReference Include="$(SolutionDir)\\B.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>`,
  }));
  workspace.write('ZApp.vcxproj', vcxproj({
    references: `<ProjectReference Include="$(SolutionDir)\\B.vcxproj"><Project>{${GUID_LIB}}</Project></ProjectReference>`,
  }));
  workspace.write('App.sln', solution().replace('App.vcxproj', 'ZApp.vcxproj'));
  const result = await scan(workspace.directory);
  assert.ok(diagnosticIds(result).has('MSB004'));
  assert.equal(result.scannedFiles.filter((file) => file.endsWith('.vcxproj')).length, 3);
});
