# Contributing

Thanks for helping make Visual C++ projects easier to maintain.

## Development

Requirements: Node.js 20 or newer and Git.

```sh
npm test
npm run check
```

Before proposing a rule, open an issue with a minimal `.sln` or `.vcxproj` example. Rules should be deterministic, work without Visual Studio, and avoid evaluating arbitrary MSBuild code. Every rule needs a valid fixture and a failing fixture.

Keep pull requests focused. Describe the user-visible behavior, test the change, and update the rule table in `README.md` when needed.
