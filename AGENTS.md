# Contributor instructions

- Keep the scanner read-only. Never evaluate or execute MSBuild projects.
- Support Node.js 20 and newer without runtime dependencies.
- Add focused tests for every rule or parser change.
- Prefer conservative diagnostics over guesses. Unknown MSBuild properties must not be treated as missing paths.
- Keep output stable because CI integrations consume JSON and SARIF.
