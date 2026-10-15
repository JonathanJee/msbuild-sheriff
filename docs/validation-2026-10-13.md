# Public repository validation (2026-10-13)

We ran the scanner against complete shallow checkouts of five public repositories at fixed commits. Each checkout remained unchanged; we did not build or evaluate any MSBuild project. The command was `node src/cli.js scan <checkout> --format json`. Counts compare the previous `v0.2.0` scanner with the corrected `v0.2.1` scanner.

| Repository at scanned commit | v0.2.0 diagnostics | v0.2.1 diagnostics | What we learned |
| --- | ---: | ---: | --- |
| [ocornut/imgui@42a2237](https://github.com/ocornut/imgui/tree/42a22377a4d0ba92a7155c7bc961bf85acbe24b3) | 0 | 0 | The included Visual C++ example projects produced no findings. |
| [libsdl-org/SDL@b64293b](https://github.com/libsdl-org/SDL/tree/b64293b342c2cde123285199818803f83dbac612) | 453 | 9 | Local `.props` imports, separate solutions and a legacy `.vcproj` member exposed false positives that `v0.2.1` avoids. |
| [microsoft/DirectXTK@524c655](https://github.com/microsoft/DirectXTK/tree/524c655ee0b69c33f6dfec81878596b131f79671) | 7 | 0 | Separate project variants reused GUIDs. This scanner does not support `.slnx`, so this is not a full solution check. |
| [notepad-plus-plus/notepad-plus-plus@2ddf1a9](https://github.com/notepad-plus-plus/notepad-plus-plus/tree/2ddf1a9cce8034b9b21d7d6af5f052262bb11cca) | 2 | 0 | Two separate test projects reused a GUID outside a shared solution. |
| [microsoft/Detours@1dbd4ea](https://github.com/microsoft/Detours/tree/1dbd4ea281d73d478aa8d09a8b83fbd265f715f7) | 0 | 0 | The supported solution and project files produced no findings. |

The nine remaining SDL diagnostics are eight `MSB005` missing `ClInclude` references (six distinct paths) and one `MSB006` absolute SDK path warning. We checked that those referenced header paths are absent from the checkout, but a static scan cannot establish that SDL's build fails or that the metadata is wrong in every configuration. We have not opened upstream issues or pull requests about them.

This exercise validates scanner behavior and motivated the [`v0.2.1` correction](https://github.com/JonathanJee/msbuild-sheriff/releases/tag/v0.2.1). It was performed by this project's maintainer and **does not demonstrate external adoption**.
