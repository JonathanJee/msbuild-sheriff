# Security policy

## Supported versions

Security fixes are applied to the latest released version.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not include secrets or proprietary project files in a public issue. Include a minimal synthetic project when possible.

The scanner is intentionally read-only: it parses project metadata but never imports, evaluates, builds, or executes MSBuild files. A report that shows this boundary can be crossed is especially important.
