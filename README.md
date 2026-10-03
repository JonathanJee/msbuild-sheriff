# msbuild-sheriff

[![CI](https://github.com/JonathanJee/msbuild-sheriff/actions/workflows/ci.yml/badge.svg)](https://github.com/JonathanJee/msbuild-sheriff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Catch broken Visual C++ and MSBuild project metadata before an expensive build starts.

`msbuild-sheriff` is a read-only, zero-dependency CLI that scans `.sln` and `.vcxproj` metadata and validates referenced `.props` and `.targets` paths. It runs on Windows, Linux, and macOS without Visual Studio, MSBuild, or a compiler. That makes it useful as a fast pull-request check for repositories whose real builds require large Windows runners or proprietary toolchains.

> Status: early preview. The scanner is useful today, but its rule set and JSON schema may grow before 1.0.

## Quick start

From a source checkout:

```sh
npm test
node src/cli.js scan path/to/Legacy.sln
```

After the package is published:

```sh
npx msbuild-sheriff scan path/to/Legacy.sln
```

## GitHub Action

The Action works directly from this repository; no npm publication or project build is required. Check out the repository being scanned first, then pass a `.sln`, `.vcxproj`, or directory path relative to that checkout:

```yaml
jobs:
  msbuild-metadata:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: JonathanJee/msbuild-sheriff@v0.2.0
        with:
          path: path/to/Legacy.sln
          severity: warning
```

`format` may be `text` (default), `json`, or `sarif`. The Action prints results to the job log and fails when diagnostics at the selected severity are found. JSON and SARIF in the Action log are surrounded by GitHub safety markers, so the entire log is not a parseable result file; use the CLI when a file is needed. The Action validates that the requested path stays within `GITHUB_WORKSPACE`, including through directory links, and never evaluates MSBuild projects. This release does not create pull-request annotations or write a SARIF artifact.

Scan a project or every supported file below a directory:

```sh
msbuild-sheriff scan app.vcxproj
msbuild-sheriff scan . --format json
msbuild-sheriff scan Legacy.sln --format sarif > msbuild-sheriff.sarif
```

The command exits with `0` when no diagnostic at the selected threshold is found, `1` when diagnostics are found, and `2` for invalid input or command-line usage.

## Checks

| Rule | Default severity | What it catches |
| --- | --- | --- |
| `MSB001` | error | Missing or duplicate `ProjectGuid` values |
| `MSB002` | error | Broken `ProjectReference` targets, mismatched GUIDs, or referenced projects absent from the solution |
| `MSB003` | error | Solution configuration mappings that do not exist in the target project |
| `MSB004` | error | Missing unconditional `.props` or `.targets` imports when the path can be resolved safely |
| `MSB005` | error | Missing `ClCompile`, `ClInclude`, or `ResourceCompile` files |
| `MSB006` | warning | Machine-specific absolute paths or paths escaping the scan root |
| `MSB007` | warning | Duplicate item includes within a project |

`--severity info|warning|error` sets the minimum level that is printed and affects the exit code.

## Output formats

The default text output is designed for local use and CI logs:

```text
src/app.vcxproj:42: error MSB005: ClCompile file does not exist: src/missing.cpp
```

JSON output is intended for custom automation. SARIF 2.1.0 output can be generated from a source checkout for later upload to GitHub code scanning:

```sh
node src/cli.js scan Legacy.sln --format sarif > msbuild-sheriff.sarif
```

## Safety model

MSBuild files are programs. Loading them with the full MSBuild engine can import files, expand environment-dependent properties, and run custom tasks during later build phases. This project deliberately performs conservative static parsing instead:

- it never builds, imports, evaluates, or executes a project;
- it resolves only literal paths and the local `$(ProjectDir)` and `$(SolutionDir)` properties;
- it skips existence checks when an unknown property or condition makes the result uncertain;
- it never modifies project files.

This boundary keeps the scanner safe to run on an untrusted pull request. It also means the tool cannot prove that every conditional or generated project path is valid.

## Scope and limitations

The first release focuses on classic Visual C++ project metadata. It does not replace a real build, validate C++ source code, or fully implement MSBuild property evaluation. SDK-style projects and unusual hand-written solution syntax may be accepted but are not the primary compatibility target yet.

False positives and false negatives are bugs. Please report them with a small synthetic project that contains no private source code.

## Why this exists

Visual C++ builds often require a large Windows image, a specific toolset, SDKs, and long dependency builds. Many failures happen before compilation because a file was renamed, a project GUID drifted, a reference was removed, or a developer-specific absolute path was committed. Those failures can be detected cheaply on any runner.

## Roadmap

- Baselines and explicit suppressions for gradual adoption
- Pull-request annotations and SARIF artifact output for the GitHub Action
- More `.sln` variants and solution-folder awareness
- Optional Windows adapter for full MSBuild evaluation
- Changed-project mode for large monorepos

Development priorities are driven by reproducible reports from real repositories. See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a rule.

## License

MIT
