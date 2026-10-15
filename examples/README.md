# Reproducible first scan

From the repository root, run:

```sh
node src/cli.js scan examples/missing-source.vcxproj
```

The project deliberately references `missing.cpp`, which is not in the checkout. The scanner reports `MSB005` and exits with status `1`. This is a synthetic demonstration maintained in this repository, not a report from another project's build or evidence of external adoption.

To try the tool on your own repository, point the same command at a `.sln`, `.vcxproj`, or directory. The scanner reads metadata only; it does not run MSBuild. For CI, use the [GitHub Action](../README.md#github-action) with a path in the checked-out workspace.
