# Changelog

All notable changes will be documented here. This project follows Semantic Versioning.

## [Unreleased]

## [0.2.0] - 2026-10-03

### Added

- A zero-dependency GitHub Action that can scan checked-out repositories before npm publication.
- Cross-platform Action smoke tests and focused input, exit-code, and log-safety tests.

### Security

- The Action rejects scan paths outside `GITHUB_WORKSPACE` and shields untrusted project text from GitHub workflow-command parsing.

## [0.1.0] - 2026-09-30

### Added

- Initial read-only scanner for solutions, Visual C++ projects, imports, items, references, and configurations.
- Text, JSON, and SARIF output.
- Cross-platform test workflow for Node.js 20, 22, and 24.
