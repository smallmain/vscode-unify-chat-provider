# NES adaptive behavior provenance

The adaptive timing, eagerness, and edit-intent behavior in this directory is
ported from `microsoft/vscode` commit
`fc3def6774c76082adf699d366f31a557ce5573f` (VS Code 1.128.0).

- `user-interaction.ts` follows
  `extension/inlineEdits/common/userInteractionMonitor.ts` and `delay.ts` for
  the persistent 30-action feedback window, ignored limiting, weighted
  happiness score, adaptive aggressiveness, cursor-position debounce, and
  explicit eagerness delays. `DelaySession` uses a request-relative clock, but
  the upstream exponential timing-history model and internal event trace are
  intentionally outside the completion-effect boundary. State remains owned
  by one `OfficialNextEditProvider` for its full runtime lifetime.
- `prompt.ts` follows `extension/xtab/common/promptCrafting.ts` for the
  `xtabAggressiveness`, `xtab275Aggressiveness`,
  `xtab275AggressivenessHighLow`, and edit-intent strategy postscripts. The
  resolved request-level aggressiveness is frozen into each built prompt.
- `edit-intent.ts` and `response.ts` follow
  `extension/xtab/node/editIntent.ts`, `responseFormatHandlers.ts`, and
  `platform/inlineEdits/common/dataTypes/xtabPromptOptions.ts` for tagged and
  short-name parsing, permissive parse-error fallback, and pre-edit filtering.
- `completion/copilot/nes-provider.ts` preserves the stateful/fresh ordering in
  `nextEditProvider.ts` and `xtabProvider.ts`: cache, speculative, and compatible
  pending-stream reuse run before the fresh empty-history gate; an eligible
  request creates its `DelaySession` before context and transport. A fresh caller
  resolves from the first edit while the remaining stream continues in the
  background. A regular pending-stream join waits for the full stream result;
  a speculative join resolves when that speculative request settles its first
  edit. Cache hits retain the originating request as their source, while regular
  and speculative joins are exposed with the current caller as their source.
  Installing a fresh request replaces the one global pending request, and a
  shown edit is scheduled against its still-running origin stream before firing
  at stream end. Consumers share a reference-counted request; cancellation
  detaches one consumer, while a short fixed grace window lets the next Core
  request reattach before the transport is cancelled. The upstream distinction
  between pre-fetch and post-fetch cancellation is not exposed as lifecycle
  metadata. Edit-intent `FilteredOut`, ordinary-filter `NoSuggestions`, and
  malformed unified response outcomes retain distinct
  retry, cache, and expansion behavior.
- Each configured Copilot provider reads `eagerness` from its own
  `completion.providers[].options`; the outer completion facade does not expose
  this Copilot-only setting as a VS Code provider option. Configuration changes
  update the existing runtime while preserving the four official values.
- `completion/copilot/nes-item.ts` follows `inlineCompletionProvider.ts` by
  rechecking cross-document target-language enablement and representing a pure
  cursor jump with `uri` and `jumpToPosition`, without an additional navigation
  command.

`test/parity/behavior-matrix.json` anchors each retained completion effect to
the pinned source. The reviewed `completion-effects.json` fixture and local
parity cases cover prompt/transport bytes, response formats, cache and rebase,
cross-file ownership, cursor retry, diagnostics arbitration, speculative
lifecycle, and completion-affecting shown/accepted/rejected/ignored state. The
fixture is deliberately not a generated upstream execution transcript; an
upstream update requires old-to-new source review before changing an expected
effect. Unit tests separately exercise default-off speculation, early
divergence, cache-distance, language-context, diagnostics-context, notebook,
and presentation branches.
