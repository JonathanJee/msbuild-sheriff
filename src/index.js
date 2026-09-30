import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = new Set(['ClCompile', 'ClInclude', 'ResourceCompile']);
const PATH_ELEMENTS = new Set(['AdditionalIncludeDirectories', 'AdditionalLibraryDirectories', 'IncludePath', 'LibraryPath']);
const RANK = { info: 0, warning: 1, error: 2 };

export class ScanError extends Error { constructor(message) { super(message); this.name = 'ScanError'; } }

/** Read-only scan. Project metadata is tokenized locally; MSBuild is never loaded or run. */
export async function scan(inputPath, options = {}) {
  const threshold = options.severity ?? 'info';
  if (!(threshold in RANK)) throw new ScanError(`Unknown severity threshold: ${threshold}`);
  if (!inputPath || networkPath(inputPath)) throw new ScanError(`Path must be local: ${inputPath}`);
  const input = path.resolve(inputPath);
  const stat = await safeLstat(input, 'input path');
  if (stat.isSymbolicLink()) throw new ScanError(`Refusing to follow symbolic-link input: ${inputPath}`);
  if (!stat.isDirectory() && !['.sln', '.vcxproj'].includes(path.extname(input).toLowerCase())) throw new ScanError(`Expected a .sln, .vcxproj, or directory: ${inputPath}`);
  const root = await scanRoot(input, stat);
  const files = stat.isDirectory() ? await discover(input) : [input];
  const slns = files.filter((f) => ext(f) === '.sln');
  const seeds = files.filter((f) => ext(f) === '.vcxproj');
  if (!slns.length && !seeds.length) throw new ScanError(`No .sln or .vcxproj files found at ${inputPath}`);

  const diagnostics = [], solutions = [];
  for (const file of slns.sort(cmp)) {
    const solution = await parseSolution(file);
    solution.members = await resolveMembers(solution, root, diagnostics);
    solution.memberPaths = new Set(solution.members.filter((m) => m.path).map((m) => normPath(m.path)));
    solutions.push(solution);
  }
  const projects = new Map(), queue = new Set(seeds);
  for (const s of solutions) for (const member of s.members) if (member.path) queue.add(member.path);
  while (queue.size) {
    const file = [...queue].sort(cmp)[0]; queue.delete(file);
    if (projects.has(normPath(file)) || (await probe(root, file)).status !== 'exists') continue;
    const project = await parseProject(file); projects.set(normPath(file), project);
    for (const reference of project.references) {
      const resolved = resolve(reference.include, project.file, null, root);
      if (resolved.status === 'resolved') queue.add(resolved.path);
    }
  }
  for (const project of projects.values()) await projectRules(project, root, diagnostics, null);
  for (const solution of solutions) await solutionRules(solution, projects, diagnostics);
  const contexts = new Map();
  for (const solution of solutions) for (const member of solution.memberPaths) (contexts.get(member) ?? contexts.set(member, []).get(member)).push(solution);
  const contextQueue = [], scheduledContexts = new Set();
  const enqueueContext = (project, solution) => {
    const key = `${normPath(project.file)}\0${solution ? normPath(solution.file) : ''}`;
    if (scheduledContexts.has(key)) return;
    scheduledContexts.add(key);
    contextQueue.push({ project, solution });
  };
  for (const project of projects.values()) {
    const owning = contexts.get(normPath(project.file));
    if (owning?.length) for (const solution of owning) enqueueContext(project, solution);
    else enqueueContext(project, null);
  }
  while (contextQueue.length) {
    const { project, solution } = contextQueue.shift();
    if (solution) {
      await importRules(project, root, diagnostics, solution.file);
      await itemPathRules(project, root, diagnostics, solution.file);
    }
    await referenceRules(project, projects, root, diagnostics, solution, enqueueContext);
  }
  duplicateGuids(projects, diagnostics);
  const scannedFiles = [...new Set([...slns, ...[...projects.values()].map((project) => project.file)])].sort(cmp);
  return { diagnostics: unique(diagnostics).filter((d) => RANK[d.severity] >= RANK[threshold]).sort(compareDiagnostics), scannedFiles };
}

export function formatText(diagnostics) { return diagnostics.map((d) => `${display(d.file)}:${d.line}:${d.column}: ${d.severity} ${d.ruleId}: ${d.message}`).join('\n'); }
export function formatJson(diagnostics) { return `${JSON.stringify(diagnostics.map((d) => ({ ...d, file: display(d.file) })), null, 2)}\n`; }
export function formatSarif(diagnostics) {
  const rules = [...new Set(diagnostics.map((d) => d.ruleId))].sort(cmp).map((id) => ({ id, shortDescription: { text: descriptions[id] ?? id } }));
  return `${JSON.stringify({ version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'msbuild-sheriff', rules } }, results: diagnostics.map((d) => ({ ruleId: d.ruleId, level: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'note', message: { text: d.message }, locations: [{ physicalLocation: { artifactLocation: { uri: uri(d.file) }, region: { startLine: d.line, startColumn: d.column } } }] })) }] }, null, 2)}\n`;
}

async function discover(folder) {
  const out = [];
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => cmp(a.name, b.name))) {
    if (['.git', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...await discover(file));
    else if (entry.isFile() && ['.sln', '.vcxproj'].includes(ext(file))) out.push(file);
  }
  return out;
}

async function scanRoot(input, stat) {
  const fallback = stat.isDirectory() ? input : path.dirname(input);
  let candidate = fallback;
  while (true) {
    try {
      const marker = await lstat(path.join(candidate, '.git'));
      if (marker.isDirectory() || marker.isFile()) return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw new ScanError(`Cannot inspect repository boundary ${candidate}: ${error.message}`);
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return fallback;
    candidate = parent;
  }
}

async function parseProject(file) {
  const source = await readLocal(file), elements = tokenize(source);
  const guids = elements.filter((e) => e.name === 'ProjectGuid').map((e) => ({ guid: guid(e.text(source)), line: line(source, e.offset) })).filter((e) => e.guid);
  const references = elements
    .filter((e) => e.name === 'ProjectReference' && e.attributes.Include)
    .flatMap((e) => list(e.attributes.Include).map((include) => ({ include, guid: guid(child(e, 'Project', source)), condition: condition(e), line: line(source, e.offset) })));
  const items = elements.filter((e) => TYPES.has(e.name) && e.attributes.Include).map((e) => ({ type: e.name, include: e.attributes.Include, condition: condition(e), line: line(source, e.offset) }));
  const imports = elements.filter((e) => e.name === 'Import' && e.attributes.Project).map((e) => ({ project: e.attributes.Project, condition: condition(e), line: line(source, e.offset) }));
  const configurations = new Set(elements.filter((e) => e.name === 'ProjectConfiguration' && e.attributes.Include).map((e) => configuration(e.attributes.Include)));
  const pathTexts = elements.filter((e) => PATH_ELEMENTS.has(e.name)).map((e) => ({ name: e.name, text: e.text(source), line: line(source, e.offset) }));
  return { file, source, guids, references, items, imports, configurations, pathTexts };
}

async function parseSolution(file) {
  const source = await readLocal(file), members = [], mappings = [];
  for (const match of source.matchAll(/^Project\("[^"\r\n]+"\)\s*=\s*"[^"]*",\s*"([^"]+\.vcxproj)",\s*"(\{[^}]+\})"/gim)) members.push({ raw: match[1], guid: guid(match[2]), line: line(source, match.index) });
  for (const match of source.matchAll(/^\s*(\{[^}]+\})\.([^=]+?)\.(ActiveCfg|Build\.0|Deploy\.0)\s*=\s*(.+?)\s*$/gim)) mappings.push({ guid: guid(match[1]), solutionConfiguration: configuration(match[2]), projectConfiguration: configuration(match[4]), line: line(source, match.index) });
  return { file, source, members, mappings };
}

async function resolveMembers(solution, root, diagnostics) {
  const out = [];
  for (const member of solution.members) {
    const result = resolve(member.raw, solution.file, solution.file, root);
    if (result.status === 'unresolved') continue;
    if (result.status === 'external') { add(diagnostics, 'MSB002', 'warning', `Solution member is outside the scan root and was not read: ${member.raw}.`, solution.file, member.line); continue; }
    if ((await probe(root, result.path)).status !== 'exists') { add(diagnostics, 'MSB002', 'error', `Solution member project does not exist: ${member.raw}.`, solution.file, member.line); continue; }
    out.push({ ...member, path: result.path });
  }
  return out;
}

async function projectRules(project, root, diagnostics, solutionFile) {
  const counts = new Map(); for (const entry of project.guids) counts.set(entry.guid, (counts.get(entry.guid) ?? 0) + 1);
  if (!project.guids.length) add(diagnostics, 'MSB001', 'error', 'ProjectGuid is missing.', project.file, 1);
  for (const [value, count] of counts) if (count > 1) for (const entry of project.guids.filter((g) => g.guid === value)) add(diagnostics, 'MSB001', 'error', `ProjectGuid ${value} is declared ${count} times in this project.`, project.file, entry.line);
  await importRules(project, root, diagnostics, solutionFile);
  const seen = new Set();
  for (const item of project.items) for (const include of list(item.include)) {
    const key = `${item.type}\0${normValue(include)}\0${normCondition(item.condition)}`;
    if (seen.has(key)) add(diagnostics, 'MSB007', 'warning', `Duplicate ${item.type} Include: ${include}.`, project.file, item.line); else seen.add(key);
  }
  await itemPathRules(project, root, diagnostics, solutionFile);
  for (const entry of project.pathTexts) for (const value of list(entry.text)) absolute(value, project.file, entry.line, diagnostics, entry.name.includes('Library') ? 'library' : 'include');
}

async function itemPathRules(project, root, diagnostics, solutionFile) {
  for (const item of project.items) for (const include of list(item.include)) {
    absolute(include, project.file, item.line, diagnostics, 'item');
    if (item.condition || include.includes('@(') || include.includes('%(') || glob(include)) continue;
    const result = resolve(include, project.file, solutionFile, root);
    if (result.status === 'external') { external(include, project.file, item.line, diagnostics, 'item'); continue; }
    if (result.status !== 'resolved') continue;
    const status = await probe(root, result.path);
    if (status.status === 'external') { external(include, project.file, item.line, diagnostics, 'item'); continue; }
    if (status.status === 'missing') add(diagnostics, 'MSB005', 'error', `${item.type} file does not exist: ${include}.`, project.file, item.line);
  }
}

async function importRules(project, root, diagnostics, solutionFile) {
  for (const entry of project.imports) {
    if (entry.condition || glob(entry.project)) continue;
    absolute(entry.project, project.file, entry.line, diagnostics, 'import');
    const result = resolve(entry.project, project.file, solutionFile, root);
    if (result.status === 'external') { external(entry.project, project.file, entry.line, diagnostics, 'import'); continue; }
    if (result.status !== 'resolved') continue;
    const status = await probe(root, result.path);
    if (status.status === 'external') { external(entry.project, project.file, entry.line, diagnostics, 'import'); continue; }
    if (status.status === 'missing') add(diagnostics, 'MSB004', 'error', `Unconditional Import target does not exist: ${entry.project}.`, project.file, entry.line);
  }
}

function duplicateGuids(projects, diagnostics) {
  const owners = new Map();
  for (const project of projects.values()) for (const value of new Set(project.guids.map((g) => g.guid))) (owners.get(value) ?? owners.set(value, []).get(value)).push(project);
  for (const [value, same] of owners) if (same.length > 1) for (const project of same) for (const entry of project.guids.filter((g) => g.guid === value)) add(diagnostics, 'MSB001', 'error', `ProjectGuid ${value} is also declared by another project.`, project.file, entry.line);
}

async function solutionRules(solution, projects, diagnostics) {
  const byGuid = new Map();
  for (const member of solution.members) {
    (byGuid.get(member.guid) ?? byGuid.set(member.guid, []).get(member.guid)).push(member);
    if (!member.path) continue;
    const project = projects.get(normPath(member.path));
    if (project?.guids.length && !project.guids.some((g) => g.guid === member.guid)) add(diagnostics, 'MSB002', 'error', `Solution project GUID ${member.guid} does not match target ProjectGuid ${project.guids[0].guid}.`, solution.file, member.line);
  }
  for (const mapping of solution.mappings) {
    const members = byGuid.get(mapping.guid);
    if (!members?.length) { add(diagnostics, 'MSB003', 'error', `Solution configuration mapping references stale project GUID ${mapping.guid}.`, solution.file, mapping.line); continue; }
    for (const member of members) { const project = member.path && projects.get(normPath(member.path)); if (project && !project.configurations.has(mapping.projectConfiguration)) add(diagnostics, 'MSB003', 'error', `Solution mapping ${mapping.solutionConfiguration} selects missing project configuration ${mapping.projectConfiguration}.`, solution.file, mapping.line); }
  }
}

async function referenceRules(project, projects, root, diagnostics, solution, enqueueContext) {
  for (const ref of project.references) {
    absolute(ref.include, project.file, ref.line, diagnostics, 'project reference');
    if (ref.condition || glob(ref.include)) continue;
    const result = resolve(ref.include, project.file, solution?.file ?? null, root);
    if (result.status === 'unresolved') continue;
    if (result.status === 'external') { external(ref.include, project.file, ref.line, diagnostics, 'project reference'); continue; }
    const status = await probe(root, result.path);
    if (status.status === 'external') { external(ref.include, project.file, ref.line, diagnostics, 'project reference'); continue; }
    if (status.status === 'missing') { add(diagnostics, 'MSB002', 'error', `ProjectReference target does not exist: ${ref.include}.`, project.file, ref.line); continue; }
    if (solution && !solution.memberPaths.has(normPath(result.path))) add(diagnostics, 'MSB002', 'warning', `ProjectReference target is not a member of solution ${path.basename(solution.file)}: ${ref.include}.`, project.file, ref.line);
    let target = projects.get(normPath(result.path));
    if (!target) {
      target = await parseProject(result.path);
      projects.set(normPath(result.path), target);
      await projectRules(target, root, diagnostics, null);
    }
    enqueueContext(target, solution);
    if (ref.guid && target.guids.length && !target.guids.some((g) => g.guid === ref.guid)) add(diagnostics, 'MSB002', 'error', `ProjectReference GUID ${ref.guid} does not match target ProjectGuid ${target.guids[0].guid}.`, project.file, ref.line);
  }
}

function resolve(rawValue, projectFile, solutionFile, root) {
  const raw = String(rawValue).trim();
  if (!raw || /@\([^)]*\)|%\([^)]*\)/.test(raw)) return { status: 'unresolved' };
  const macros = [...raw.matchAll(/\$\(([^)]+)\)/g)].map((m) => m[1].toLowerCase());
  if (macros.some((m) => !['projectdir', 'solutiondir'].includes(m))) return { status: 'unresolved' };
  if (macros.includes('solutiondir') && !solutionFile) return { status: 'unresolved' };
  if (absolutePath(raw)) return { status: 'external' };
  let value = raw.replaceAll('\\', '/').replaceAll(/\$\(ProjectDir\)/gi, `${path.dirname(projectFile)}${path.sep}`);
  if (solutionFile) value = value.replaceAll(/\$\(SolutionDir\)/gi, `${path.dirname(solutionFile)}${path.sep}`);
  const candidate = path.resolve(path.isAbsolute(value) ? value : path.join(path.dirname(projectFile), value));
  return inside(root, candidate) ? { status: 'resolved', path: candidate } : { status: 'external' };
}

async function probe(root, candidate) {
  if (!inside(root, candidate)) return { status: 'external' };
  let cursor = root;
  let currentStat = null;
  for (const piece of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, piece);
    try {
      currentStat = await lstat(cursor);
      if (currentStat.isSymbolicLink()) return { status: 'external' };
    }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'missing' };
      throw new ScanError(`Cannot inspect ${cursor}: ${error.message}`);
    }
  }
  if (!currentStat) currentStat = await lstat(candidate);
  return currentStat.isFile() ? { status: 'exists', path: cursor } : { status: 'missing' };
}

function tokenize(source) {
  const elements = [], stack = [];
  for (let i = 0; i < source.length;) {
    if (source[i] !== '<') { i += 1; continue; }
    if (source.startsWith('<!--', i)) { const end = source.indexOf('-->', i + 4); i = end < 0 ? source.length : end + 3; continue; }
    if (source.startsWith('<![CDATA[', i)) { const end = source.indexOf(']]>', i + 9); i = end < 0 ? source.length : end + 3; continue; }
    if (source.startsWith('<?', i) || source.startsWith('<!', i)) { const end = tagEnd(source, i + 1); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('</', i)) { const end = source.indexOf('>', i + 2), name = source.slice(i + 2, end < 0 ? source.length : end).trim().split(/\s/, 1)[0]; for (let j = stack.length - 1; j >= 0; j -= 1) if (stack[j].name === name) { stack[j].close = i; stack.length = j; break; } i = end < 0 ? source.length : end + 1; continue; }
    const end = tagEnd(source, i + 1); if (end < 0) break;
    const raw = source.slice(i + 1, end), match = raw.match(/^\s*([A-Za-z_][\w:.-]*)\b/); if (!match) { i = end + 1; continue; }
    const selfClosing = /\/\s*$/.test(raw), element = { name: match[1], offset: i, body: end + 1, close: selfClosing ? end + 1 : source.length, attributes: attrs(raw.slice(match[0].length)), parent: stack.at(-1) ?? null, children: [], text(s) { return decode(s.slice(this.body, this.close).replace(/<[^>]*>/g, '')).trim(); } };
    if (element.parent) element.parent.children.push(element); elements.push(element); if (!selfClosing) stack.push(element); i = end + 1;
  }
  return elements;
}

function tagEnd(source, start) { let quote = ''; for (let i = start; i < source.length; i += 1) { const c = source[i]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') return i; } return -1; }
function attrs(raw) { const out = {}; for (const m of raw.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)')/g)) out[m[1]] = decode(m[2] ?? m[3] ?? ''); return out; }
function child(element, name, source) { const found = element.children.find((e) => e.name === name); return found ? found.text(source) : ''; }
function condition(element) {
  const parts = [];
  for (let current = element; current; current = current.parent) {
    if (current.attributes?.Condition) parts.push(current.attributes.Condition);
    if (current !== element && (current.name === 'When' || current.name === 'Otherwise')) parts.push(`branch:${current.name}@${current.offset}`);
  }
  return parts.reverse().join(' && ');
}
function networkPath(value) { return /^\\\\/.test(String(value)) || /^\/\//.test(String(value)); }
function absolutePath(value) { return networkPath(value) || /^[A-Za-z]:[\\/]/.test(String(value)) || String(value).startsWith('/'); }
function inside(root, value) { const relative = path.relative(root, value); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
async function safeLstat(file, label) {
  try { return await lstat(file); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new ScanError(`Path does not exist: ${file}`);
    throw new ScanError(`Cannot read ${label} ${file}: ${error.message}`);
  }
}
async function readLocal(file) { try { if ((await lstat(file)).isSymbolicLink()) throw new Error('symbolic link'); return await readFile(file, 'utf8'); } catch (error) { throw new ScanError(`Cannot read ${file}: ${error.message}`); } }
function absolute(value, file, lineNumber, diagnostics, kind) { const text = String(value).trim(); if (text && absolutePath(text)) add(diagnostics, 'MSB006', 'warning', `Absolute ${kind} path harms portability: ${text}.`, file, lineNumber); }
function external(value, file, lineNumber, diagnostics, kind) { if (absolutePath(value)) return; add(diagnostics, 'MSB006', 'warning', `${kind[0].toUpperCase()}${kind.slice(1)} path escapes the scan root and was not read: ${String(value).trim()}.`, file, lineNumber); }
function list(value) { return String(value).split(';').map((s) => s.trim()).filter(Boolean); }
function glob(value) { return /[*?]/.test(value); }
function guid(value) { const match = String(value).trim().match(/^\{?([0-9a-fA-F-]{36})\}?$/); return match ? `{${match[1].toUpperCase()}}` : ''; }
function configuration(value) { return String(value).trim().toLowerCase().replace(/\s+/g, ' '); }
function normPath(value) { return path.normalize(path.resolve(value)).toLowerCase(); }
function normValue(value) { return String(value).trim().replaceAll('\\', '/').toLowerCase(); }
function normCondition(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function ext(file) { return path.extname(file).toLowerCase(); }
function line(source, offset) { let result = 1; for (let i = 0; i < offset; i += 1) if (source.charCodeAt(i) === 10) result += 1; return result; }
function decode(value) { return String(value).replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'); }
function add(list, ruleId, severity, message, file, lineNumber, column = 1) { list.push({ ruleId, severity, message, file: path.resolve(file), line: Math.max(1, lineNumber), column }); }
function unique(items) { const seen = new Set(); return items.filter((d) => { const key = `${d.ruleId}\0${d.severity}\0${d.file}\0${d.line}\0${d.column}\0${d.message}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function compareDiagnostics(a, b) { return cmp(a.file, b.file) || a.line - b.line || a.column - b.column || cmp(a.ruleId, b.ruleId) || cmp(a.message, b.message); }
function cmp(a, b) { return String(a).localeCompare(String(b), 'en', { sensitivity: 'base' }); }
function outside(relative) { return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); }
function display(file) { const relative = path.relative(process.cwd(), file); return outside(relative) ? pathToFileURL(file).href : (relative || '.').replaceAll(path.sep, '/'); }
function uri(file) {
  const relative = path.relative(process.cwd(), file);
  if (outside(relative)) return pathToFileURL(file).href;
  return (relative || '.').split(path.sep).map(encodeURIComponent).join('/');
}
const descriptions = { MSB001: 'ProjectGuid is missing or duplicated.', MSB002: 'ProjectReference target, GUID, or solution membership is invalid.', MSB003: 'Solution configuration mapping is stale or not declared by its project.', MSB004: 'An unconditional Import target is missing.', MSB005: 'A source, header, or resource item is missing.', MSB006: 'An absolute or external path harms portability.', MSB007: 'An item Include appears more than once in the same condition.' };
