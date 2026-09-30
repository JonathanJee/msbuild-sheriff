#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { formatJson, formatSarif, formatText, ScanError, scan } from './index.js';

const usage = 'Usage: msbuild-sheriff scan <path> [--format text|json|sarif] [--severity info|warning|error]';

export async function run(args, streams = {}) {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  try {
    if (args[0] !== 'scan' || !args[1]) throw new ScanError(usage);
    const input = args[1];
    let format = 'text';
    let severity = 'info';
    for (let index = 2; index < args.length; index += 1) {
      const option = args[index];
      if (option === '--format' || option === '--severity') {
        const value = args[++index];
        if (!value) throw new ScanError(`Missing value for ${option}.\n${usage}`);
        if (option === '--format') format = value;
        else severity = value;
      } else {
        throw new ScanError(`Unknown option: ${option}.\n${usage}`);
      }
    }
    if (!['text', 'json', 'sarif'].includes(format)) throw new ScanError(`Unknown format: ${format}.\n${usage}`);
    const result = await scan(input, { severity });
    const output = format === 'json' ? formatJson(result.diagnostics)
      : format === 'sarif' ? formatSarif(result.diagnostics)
        : formatText(result.diagnostics) || 'No findings.';
    if (output) stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return result.diagnostics.length > 0 ? 1 : 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
