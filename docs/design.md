# Design notes

## Goal

Provide fast, deterministic checks for failures visible in MSBuild metadata without needing the MSBuild engine or executing repository code.

## Pipeline

1. Discover `.sln` and `.vcxproj` inputs.
2. Parse solutions into projects and configuration mappings.
3. Parse XML project metadata with a non-evaluating tokenizer and retain line locations.
4. Resolve only literal paths plus `ProjectDir` and `SolutionDir`.
5. Run independent rules and collect normalized diagnostics.
6. Filter by severity and render text, JSON, or SARIF.

Diagnostics use this stable internal shape:

```json
{
  "ruleId": "MSB005",
  "severity": "error",
  "message": "ClCompile file does not exist: src/missing.cpp",
  "file": "src/app.vcxproj",
  "line": 42
}
```

## Trust boundary

Input is untrusted text. The parser must never invoke MSBuild, a shell, a compiler, project hooks, or paths found in the project. Unknown properties and conditioned imports remain unresolved. This produces fewer diagnostics but avoids unsafe evaluation and misleading guesses.

## Compatibility policy

Text wording may improve between minor releases. Rule IDs, JSON field names, exit codes, and valid SARIF structure should remain compatible. A breaking schema change requires a major version after 1.0.
