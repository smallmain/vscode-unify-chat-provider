# GhostText core provenance

This directory is a strict, host-neutral port of the inline-completion behavior
from `microsoft/vscode` commit
`fc3def6774c76082adf699d366f31a557ce5573f` (VS Code 1.128.0).

The corresponding upstream entry points in `src/chat-lib/upstream` are:

- `.../lib/src/inlineCompletion.ts` and `.../ghostText/ghostText.ts` for the
  request state machine, cycling, current completion and speculative requests.
- `.../prompt/completionsPromptFactory/*`,
  `components/splitContextPromptRenderer.tsx`, and `components/elision.ts` for
  the production split-context prompt, five-token suffix encoding reserve,
  shared prefix/context budget, suffix surplus transfer, and `WishlistElision`.
  `extractPrompt` always requests this split-context path; the unregistered
  abstract cascading factory is not used by this port.
- `.../prompt/contextProviderRegistry.ts`, `contextProviderStatistics.ts`,
  `components/contextProviderBridge.ts`, `contextProviders/{traits,codeSnippets,diagnostics}.ts`,
  and `components/{traits,codeSnippets,diagnostics}.tsx` for Context Provider
  API v1 resolution and usage feedback. The host preserves `data`, proposed
  edits, provider/item identity, timeout resolution, and content-exclusion
  expectations; final split-context elision reports expected and actual tokens
  at the official source-leaf granularity. A separate 25-completion LRU then
  supplies the most recent different completion's statistics as
  `previousUsageStatistics`.
- `.../ghostText/completionsCache.ts`, `asyncCompletions.ts`, and `current.ts`
  for cache and typing-as-suggested behavior.
- `.../ghostText/configBlockMode.ts`, `ghostTextStrategy.ts`,
  `multilineModel.ts`, `streamedCompletionSplitter.ts`, `statementTree.ts`, and
  `blockTrimmer.ts` for per-language block-mode selection, block-position-specific
  9/3 lookahead, progressive-reveal prefix-addition caching, and trimming. The generated
  multiline model weights and character map are imported directly from the
  pinned snapshot. `scripts/chat-lib-parser-entry.ts` bundles the pinned
  Tree-sitter parser and `TerseBlockTrimmer` into `dist/chat-lib-parser.cjs`;
  `parser-runtime.ts` exposes only a runtime-validated strict interface, and
  the matching pinned WASM resources are copied beside that bundle. The single
  `CHAT_LIB_TREE_SITTER_WASM_FILES` declaration drives extraction metadata and
  packaging. Its isolated smoke check loads every grammar used by parsing or
  `BlockTrimmer`, including C#, Java, PHP, and C++ grammars that upstream
  disables for general parsing but still exposes through `StatementTree`.
  The replacement FIM boundary is intentionally non-streaming; the same
  splitter state machine runs over the complete response after it arrives, so
  subsequent segments and cache keys remain equivalent without reproducing the
  upstream first-choice/background delivery timing.
- `.../suggestions/suggestions.ts`, `ghostText/copilotCompletion.ts`, and
  `ghostText/normalizeIndent.ts` for suffix coverage, duplicate filtering,
  range construction and indentation normalization.
- `.../prompt/snippetInclusion/selectRelevance.ts`, `similarFiles.ts`, and
  `jaccardMatching.ts` for the shared case-sensitive stopword filtering,
  sliding-window ranking, and language-specific candidate limits used by FIM
  and NES.
- `.../prompt/src/tokenization/tokenizer.ts` for the production o200k
  character-prewindow and boundary-retokenization behavior used by suffix and
  last-line truncation; tests include real BPE boundary vectors rather than
  relying only on the character tokenizer.
- `.../extension/src/ghostText/ghostTextProvider.ts` and `.../ghostText/last.ts`
  for the shown state that affects speculative requests and candidate ordering,
  plus accepted/discarded ownership cleanup. Partial-acceptance counters and
  lifecycle feedback metadata are intentionally outside the completion-effect
  boundary because the production host has no feedback sink.

Authentication, telemetry upload and test spies, legacy OpenAI/Snippy network
transport, Copilot model-picker UI, and dependency injection are intentionally
replaced by local host interfaces. `FimGhostTextModelBoundary` connects this
core to the unified `CompletionModel`; the retained `openai/openai.ts` and
`networkingTypes.ts` provide completion-choice and abort-classification
algorithms, not network I/O. Prompt, parser, post-processing, cache, and
completion-affecting lifecycle behavior remain inside this core.

The host-level Copilot option `completion.providers[].options.n` intentionally
overrides the official cycling candidate count. Its local default is one. The
FIM boundary keeps the effective `candidateCount` in the AlgorithmRequest, and
`CompletionModel` lowers it to one for single-result transports. Supported
native multi-candidate transports map the effective count to their protocol;
compatible FIM transports do not receive an `n` model option. Request-level
temperature is intentionally not reproduced. This local default is not updated
during upstream Copilot synchronization.
