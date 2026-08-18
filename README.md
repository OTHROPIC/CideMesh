# SlideMesh

A local desktop application that ingests legacy, absolute-positioned PowerPoint (`.pptx`) files, lets you
organize flat shapes into hierarchical container trees, assign responsive layout rules, and compile the
result into PowerPoint or HTML at any target aspect ratio.

**Status: pre-implementation.** The design is settled; no code exists yet.

| Document | What it holds |
| :--- | :--- |
| [DESIGN.md](DESIGN.md) | Requirements and design — the architecture of record |
| [doc/api/core-api-spec.md](doc/api/core-api-spec.md) | Core API conventions: envelope, error codes, patches |
| [src/core/model/manifest.ts](src/core/model/manifest.ts) | The manifest schema — source, not documentation |

New to the project? Read [DESIGN.md](DESIGN.md) §1 and §3.
