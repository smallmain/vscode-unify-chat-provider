# Chat-lib behavior matrix

The completion parity boundary is pinned to VS Code commit
`fc3def6774c76082adf699d366f31a557ce5573f`. The machine-readable review index
is `behavior-matrix.json`; each row records one completion-affecting observable,
its upstream source path, source range, and anchor.

## Evidence model

`fixtures/completion-effects.json` is a small, reviewed set of expected
completion effects. It intentionally is not a generated execution transcript of
the upstream extension. Every matrix row must have exactly one effect entry and
one executable local parity case. `parity.test.ts` rejects missing, duplicate,
or extra IDs.

The evidence proves the behavior that matters to a user of completion:

- prompt and model-request content;
- completion text, replacement range, filtering, and presentation;
- trigger and eligibility decisions;
- cache, rebase, speculative reuse, and cursor-retry results;
- model-unification topology, diagnostics, and separate/joint FIM/NES winners;
- cancellation or disposal when it can change a returned result or retained
  completion state.

The evidence does not try to reproduce authentication, entitlement, telemetry,
product UI, private event logs, exact wall-clock traces, or callback multiplicity
that cannot change a completion result. Fake clocks remain useful for testing
deadlines, debounce bounds, and winner selection, but timestamp arrays are not a
parity surface.

The effect fixture is a review baseline, not an independent oracle. During an
upstream update, maintainers must inspect the old-to-new official diff, update
the runtime port first, and then review each affected effect entry against the
pinned source. Copying current local output into the fixture without that review
does not establish parity.

## Runtime snapshot

`src/chat-lib/upstream` contains only the official source closure that is
compiled into the parser/diff runtime or imported for constants. The extractor
starts from `CHAT_LIB_RUNTIME_ENTRIES`, follows imports after the declared
mechanical transforms, and records hashes and edges in
`dependency-manifest.json`. Host extension roots and evidence-only
sources are deliberately excluded.

`npm run extract:chat-lib` stages the following work in a temporary candidate:

1. extract the pinned runtime closure;
2. verify hashes, boundaries, provenance, and strict types;
3. build and smoke-test parser/diff bundles and copy WASM resources;
4. run the completion-effect parity suite.

Only the runtime snapshot and `dist` outputs are published after every phase
succeeds. The reviewed behavior matrix and effect fixture are hand-maintained
inputs to that workflow.

## Updating the pin

Before selecting a new commit:

1. compare the current and target commits across Copilot FIM, NES, model
   unification, diagnostics, separate/joint Provider routing, editor
   presentation, parser, and diff dependencies;
2. map every completion-affecting change to `src/chat-lib/core`,
   `src/completion/copilot`, a matrix row, and focused unit/parity/E2E coverage;
3. update matrix source anchors and `src/chat-lib/porting-manifest.json`;
4. review affected completion effects and document every intentionally excluded
   difference in `allowedDifferences`;
5. run the atomic updater and an independent implementation review.

Use an external VS Code checkout containing the pinned Git object. It does not
need dependencies or a checked-out worktree because extraction reads objects
with `git show`.

```sh
npm run extract:chat-lib -- --source /path/to/vscode
npm run extract:chat-lib -- --source /path/to/vscode --check
npm run verify:chat-lib
npm run check
npm run test:e2e
```

The `--check` form performs all candidate phases, compares the generated runtime
snapshot, and leaves the repository unchanged.
