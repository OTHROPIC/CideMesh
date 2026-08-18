# Core API Specification — Foundations

**Status:** draft, awaiting sign-off. Method *inventory* will keep growing; the conventions below are meant to stay fixed so that growth costs nothing.

This document settles the parts that are expensive to change later: how a call is addressed, what a request carries, what a response looks like, how errors travel, and how results are versioned. Individual methods are specified in §8 and are expected to change.

---

## 1. Transport neutrality

One API, three bindings. The core exposes plain TypeScript functions; adapters map them onto transports.

| Binding | Address form | Notes |
| :--- | :--- | :--- |
| Electron IPC | `invoke("core", request)` | Single channel, method in the payload. Not one channel per method. |
| MCP | tool name `slidemesh_<domain>_<action>` | Tool schema generated from the same param types. |
| CLI | `slidemesh <domain> <action> --flag=value` | Flags map 1:1 to params. |

A single IPC channel carrying a method name — rather than a channel per method — means adding a method never touches the preload bridge, and the bridge's allowlist stays one entry.

---

## 2. Naming

`<domain>.<action>`, both lowerCamelCase, dot-separated.

    presentation.load        tree.reparent          style.update
    presentation.save        tree.setVisibility     style.create
    export.run               tree.rename            target.create

* **Domain is a noun, action is a verb.** `tree.reparent`, not `reparentNode`.
* **No `get` prefix** on reads: `tree.list`, not `tree.getList`.
* Actions that mutate use a verb that names the mutation (`reparent`, `setVisibility`), never `update` with a free-form body — except `style.update`, where a partial patch genuinely is the operation.

---

## 3. Identifiers and parameter typing

**Every id carries a type prefix.** This is the answer to "which id goes where": the type is visible at every layer — in a log line, an MCP tool call, a CLI flag — and passing a style id where a node id belongs fails at validation instead of silently resolving to nothing.

| Prefix | Resource | Example |
| :--- | :--- | :--- |
| `nd_` | tree node | `nd_7f3a` |
| `sl_` | slide | `sl_02` |
| `st_` | style | `st_title` |
| `tg_` | export target | `tg_16x9` |
| `job_` | long-running job | `job_91c2` |

Rules:

* **Params are a flat named object.** No positional arguments, ever — adding a param must never reorder existing ones.
* **Ids are opaque strings.** Never parse them; the prefix is for validation and readability, not addressing.
* **Nesting is by reference, not by path.** `{ slideId, nodeId }` rather than `"sl_02/nd_7f3a"` — paths invite string surgery, and a node id is already globally unique.
* **Optional means optional.** Omit a key rather than sending `null`, which is reserved for "explicitly cleared" (e.g. `parent: null` at the root).
* **Units are explicit in the name.** `widthEmu: number` or `width: "50%"` — never a bare `width: number` whose unit depends on context.

---

## 4. Request envelope

```jsonc
{
  "apiVersion": 1,
  "method": "tree.reparent",
  "params": { "nodeId": "nd_7f3a", "newParentId": "nd_1c02", "before": "nd_9a41" },
  "meta": {
    "requestId": "req_8812",      // caller-generated; echoed back for correlation
    "workspaceId": "ws_4b7e",     // which open project this targets
    "clientRev": 42               // last manifest revision the caller has seen
  }
}
```

`clientRev` is what makes concurrent edits safe: a mutation whose `clientRev` is behind the server's current revision is rejected with `STALE_REVISION` rather than silently overwriting. Reads may omit it.

---

## 5. Response envelope

Always a discriminated union on `ok`. **Errors are values, never thrown across a boundary** — an exception crossing IPC loses its type and its stack is meaningless in the other process.

```jsonc
// success
{
  "ok": true,
  "apiVersion": 1,
  "data": { /* method-specific */ },
  "patch": { /* see §6 — present on mutations */ },
  "meta": { "requestId": "req_8812", "rev": 43, "durationMs": 12 }
}

// failure
{
  "ok": false,
  "apiVersion": 1,
  "error": {
    "code": "STALE_REVISION",
    "message": "Manifest changed since rev 42.",
    "details": { "clientRev": 42, "currentRev": 43 },
    "retryable": true
  },
  "meta": { "requestId": "req_8812", "rev": 43 }
}
```

**Error codes are a closed, stable vocabulary.** Three fields, three jobs, and they must not be confused:

* **`code`** — what callers branch on, and the key into the remediation table below. Stable forever; adding a code is additive, changing one is breaking.
* **`message`** — human-readable, reworded freely, never parsed by anything.
* **`details`** — structured context, shaped per code, so a caller can compose a specific message ("font *Calibri* missing on 14 nodes") rather than echoing a generic one.

**Every code carries documented remediation. A code a user cannot act on is a defect**, not an acceptable outcome — `INTERNAL` is the sole exception, and its remedy is to report the bug with the `requestId`.

| Code | Meaning | Retryable | What the user should do |
| :--- | :--- | :--- | :--- |
| `INVALID_PARAMS` | Failed schema validation, or a manifest failing its invariants on open | No | `details.path` names the offending field or invariant. For a hand-edited manifest, fix the named field; otherwise report it — the UI should not be able to send invalid params. |
| `NOT_FOUND` | Referenced id does not exist | No | The object was deleted, or an id was reused across workspaces. Refresh and retry against a current id. |
| `INVARIANT_VIOLATION` | The move would break a tree rule (cycle, second root) | No | `details.invariant` says which. Usually dropping a container into its own descendant — choose a target outside the moved subtree. |
| `STALE_REVISION` | Caller's `clientRev` is behind | Yes, after refetch | Someone else (often an agent) changed the deck first. Re-read the current `rev` and reapply. The UI does this automatically; a script should refetch rather than force. |
| `UNSUPPORTED` | Not available in this build — including a legacy binary `.ppt` | No | For `.ppt`, convert to `.pptx` in PowerPoint or LibreOffice and open that. For a method, check `apiVersion`. |
| `IO_ERROR` | Filesystem or archive failure | Sometimes | `details.path` names the file. Check permissions, free space, and that the workspace has not been moved or deleted while open. |
| `PARSE_ERROR` | Source deck could not be read — corrupt, truncated, or encrypted | No | If the deck is password-protected, remove the password and re-open. If corrupt, repair it in PowerPoint first. `details.reason` distinguishes the two. |
| `EXPORT_FAILED` | Writer failed; `details.stage` says where | Sometimes | Check the output path is writable and not open in another application. If `stage` is `render`, run `export.preflight` — a `blocking` ledger row usually explains it. |
| `INTERNAL` | Unexpected; a bug | No | Report it with `meta.requestId`; the structured log entry for that id has the detail. |

**Remediation text is code, not prose.** These strings live beside the code enum in `src/core/api/errors.ts` and this table mirrors them, for the same reason the manifest schema lives in source (design §5.1): a second copy drifts. The UI resolves help text locally from the code — no network lookup, per NFR-11 — and an unrecognized code falls back to a generic message rather than failing, so an older client survives a newer core.

---

## 6. Mutations return patches, not documents

A mutation returns **only what changed**. Returning the whole manifest after every drag would send megabytes to redraw one row, and would make the renderer's store a copy rather than a projection.

```jsonc
"patch": {
  "rev": 43,
  "tree":      { "upsert": [ /* TreeItemRecord */ ], "remove": ["nd_9c11"] },
  "styles":    { "upsert": { "st_title": { /* Style */ } }, "remove": [] },
  "unmodeled": { "upsert": [], "remove": [] }
}
```

This composes with the schema's design: because the tree is flat and parent-pointed, a reparent produces a patch of exactly one record (§4.1 of the proposal). A batch style edit produces one style entry plus zero node records, since nodes reference the style rather than copying it.

**Rules:** patches are idempotent (applying twice equals applying once); `upsert` carries whole records, never field-level deltas; and any response with a `patch` also carries the new `rev` in `meta`.

---

### 6.1 Who receives what

Commands arrive from the UI, MCP, or the CLI, and all take the same path through the broker. Two message kinds leave it, routed differently:

| Kind | Correlated by | Delivered to | Why |
| :--- | :--- | :--- | :--- |
| **Response** (`ok` union) | `requestId` | The caller only | It answers one call. An MCP tool's return value is not UI business. |
| **State change** (`patch` + `rev`) | `rev` | **Every subscriber**, whatever the origin | It states that the manifest moved. The UI reflects the manifest, not its own actions. |
| **Job event** (progress, done, failed) | `jobId` | Every subscriber | The UI should be able to show that an agent's export is running. |

**State changes are never filtered by origin.** If an MCP agent reparents a node, the UI must repaint; withholding that patch because the UI did not ask for it would leave the window silently wrong. Two existing properties make broadcasting safe rather than merely tolerable: patches are **idempotent upserts keyed by id**, so a client that already applied its own edit optimistically converges instead of double-applying; and `rev` is monotonic, so a duplicate or out-of-order delivery is detectable rather than corrupting.

**Origin is an explicit field, not something decoded from an id.** Ids are opaque (§3) so their format stays free to change; anything that needs the source reads `meta.origin`:

```jsonc
"meta": { "requestId": "req_8812", "rev": 43, "origin": "mcp" }   // "ui" | "mcp" | "cli"
```

`origin` exists for attribution, not routing — labelling a change as agent-made in the UI, attributing undo steps, and structured logs. No component branches on it to decide whether to deliver a message.

## 7. Long-running work

`presentation.load` and `export.run` take seconds. They return a job immediately and stream progress on a separate event channel.

```jsonc
// response
{ "ok": true, "data": { "jobId": "job_91c2" }, "meta": { "requestId": "req_9001" } }

// events, pushed on the "core:event" channel
{ "type": "job.progress", "jobId": "job_91c2", "phase": "parsing", "pct": 40 }
{ "type": "job.done",     "jobId": "job_91c2", "result": { /* method's data */ } }
{ "type": "job.failed",   "jobId": "job_91c2", "error": { /* §5 error */ } }
```

Events use the same error shape as responses. Phases are method-specific strings, and callers must tolerate unknown ones.

---

## 8. Method inventory

Expected to grow. Signatures are `params → data`.

**Every method declares a latency class** — Immediate (≤ 50 ms), Prompt (≤ 500 ms), or Deferred (returns `{ jobId }`, streams progress, cancellable). The class is not documentation: it dictates the response shape, and a method that outgrows its class **changes class** rather than receiving a larger budget. Budgets are defined in design §3.2.1 and measured at this boundary — command received to patch emitted, excluding renderer repaint.

| Method | Class | Params | Data | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `presentation.open` | Deferred | `path, workspacePath?` | `{ jobId }` | One entry point for both file kinds — see below. |
| `presentation.save` | Prompt | — | `{ rev }` | Rewrites `manifest.json` in place; compacts order keys. |
| `presentation.close` | Immediate | — | `{}` | Releases the workspace. |
| `tree.reparent` | Immediate | `nodeId, newParentId, before?` | `{}` | `before` is a sibling id; omit to append. Patch of one record. |
| `tree.setVisibility` | Immediate | `nodeId, isVisible, cascade?` | `{}` | |
| `tree.group` | Immediate / Prompt | `nodeIds[], name?` | `{ containerId }` | Prompt past ~50 selected nodes. |
| `tree.ungroup` | Immediate / Prompt | `containerId` | `{}` | Children reparent to the container's parent. |
| `tree.setLayout` | Immediate | `nodeId, layout, targetId?` | `{}` | With `targetId`, writes a sparse override instead. |
| `style.create` | Immediate | `name, props` | `{ styleId }` | |
| `style.update` | Immediate | `styleId, props` | `{}` | Patch is one style entry however many nodes reference it. The repaint it triggers is budgeted separately. |
| `style.assign` | Immediate | `nodeIds[], styleId` | `{}` | |
| `target.create` | Immediate | `label, cx, cy` | `{ targetId }` | |
| `export.preflight` | Prompt | `targetId?` | `{ warnings[] }` | Loss-ledger rows that would bite. Never writes. |
| `export.run` | Deferred | `outputPath, targetId?` | `{ jobId }` | Fidelity written to `lastExport`. |

### 8.1 `presentation.open` — one method, two file kinds

The file picker accepts a `.pptx` or a `manifest.json`, and the method branches on what it is given. One entry point, because "open my work" is one user intention regardless of which file they point at.

| `path` is… | Behavior | `workspacePath` |
| :--- | :--- | :--- |
| `*.pptx` | Import: create the workspace, unzip into `res/`, parse, build the manifest | Required. The UI supplies it, defaulting to a folder beside the source deck |
| `manifest.json` | Reopen: read the manifest, validate invariants, rebuild computed indexes | Ignored — the workspace is the file's own directory |

The import branch dominates the latency class; reopening an existing manifest finishes far inside the Deferred budget, which is permitted (a class is a ceiling, not a target).

Errors follow §5: a `.pptx` that is encrypted or corrupt yields `PARSE_ERROR`, a binary `.ppt` yields `UNSUPPORTED`, and a manifest failing schema or tree invariants yields `INVALID_PARAMS` with the failing invariant in `details`.

Because the workspace location is chosen at import time, there is no "unsaved workspace" state and no save-as: `presentation.save` always rewrites `manifest.json` where it already lives, which is what keeps it in the Prompt class.

`export.preflight` exists so the pre-export warning (design §6) is a first-class call rather than a side effect of exporting.

---

## 9. Evolution rules

The inventory changes constantly; these rules keep that free.

1. **Additive by default.** New optional params and new response fields do not bump `apiVersion`.
2. **`apiVersion` bumps only on breaking change** — a removed method, a renamed param, a changed type, a new required param.
3. **Deprecate before removing.** A superseded method keeps working and returns `meta.deprecated: "use tree.setLayout"`.
4. **Unknown fields are ignored, not rejected**, in both directions — an older renderer must survive a newer core.
5. **Never overload a param's meaning.** A new concept gets a new name, even when an old one nearly fits.
