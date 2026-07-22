import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const COPILOT_ROOT = 'extensions/copilot';
export const COPILOT_SOURCE_ROOT = `${COPILOT_ROOT}/src/`;
export const CHAT_LIB_SNAPSHOT_ROOT = 'src/chat-lib/upstream';

export const CHAT_LIB_TREE_SITTER_WASM_FILES = [
  'tree-sitter.wasm',
  'tree-sitter-c-sharp.wasm',
  'tree-sitter-cpp.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-java.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-php.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-ruby.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-typescript.wasm',
] as const;

export interface ChatLibRuntimeEntry {
  id: string;
  sourcePath: string;
  purpose: string;
}

export const CHAT_LIB_RUNTIME_ENTRIES: readonly ChatLibRuntimeEntry[] = [
  {
    id: 'ghost-text-contextual-filter',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/ghostText/contextualFilterConstants.ts`,
    purpose: 'Compiled GhostText contextual-filter constants.',
  },
  {
    id: 'ghost-text-multiline-weights',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/ghostText/multilineModelWeights.ts`,
    purpose: 'Compiled GhostText multiline model weights and character map.',
  },
  {
    id: 'inline-edit-presentation',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/inlineEdits/vscode-node/isInlineSuggestion.ts`,
    purpose: 'Compiled inline-suggestion presentation predicate.',
  },
  {
    id: 'nes-system-messages',
    sourcePath: `${COPILOT_SOURCE_ROOT}extension/xtab/common/systemMessages.ts`,
    purpose: 'Compiled NES system prompts.',
  },
  {
    id: 'nes-tags',
    sourcePath: `${COPILOT_SOURCE_ROOT}extension/xtab/common/tags.ts`,
    purpose: 'Compiled NES prompt and response tags.',
  },
  {
    id: 'parser-block-trimmer',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/ghostText/blockTrimmer.ts`,
    purpose: 'Bundled multiline completion block trimming.',
  },
  {
    id: 'parser-statement-tree',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/ghostText/statementTree.ts`,
    purpose: 'Bundled statement-tree block position detection.',
  },
  {
    id: 'parser-language-support',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/prompt/src/parse.ts`,
    purpose: 'Bundled parser language support and WASM loading.',
  },
  {
    id: 'parser-block-boundaries',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/prompt/src/parseBlock.ts`,
    purpose: 'Bundled parsed-block completion boundaries.',
  },
  {
    id: 'diff-computer',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}util/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.ts`,
    purpose: 'Bundled detailed line diff implementation used by NES rebase.',
  },
  {
    id: 'diff-text',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}util/vs/editor/common/core/text/abstractText.ts`,
    purpose: 'Bundled text/range conversion used by the NES diff runtime.',
  },
  {
    id: 'diff-offset-transform',
    sourcePath:
      `${COPILOT_SOURCE_ROOT}util/vs/editor/common/core/text/positionToOffset.ts`,
    purpose: 'Bundled position-to-offset transformation used by the NES diff runtime.',
  },
];

export interface ChatLibBoundaryRule {
  id: string;
  sourcePrefixes: readonly string[];
  replacement: string;
  rationale: string;
}

/**
 * These are deliberate host-integration seams, not unresolved imports. The port
 * supplies local adapters for them; algorithm and state modules remain in the
 * extracted dependency graph.
 */
export const CHAT_LIB_BOUNDARY_RULES: readonly ChatLibBoundaryRule[] = [
  {
    id: 'configured-model-auth',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}platform/authentication/`,
      `${COPILOT_SOURCE_ROOT}platform/endpoint/`,
      `${COPILOT_SOURCE_ROOT}platform/networking/`,
    ],
    replacement: 'CompletionModelReference, CompletionModel, and LanguageModelChat adapters.',
    rationale: 'This extension owns completion model selection and transport.',
  },
  {
    id: 'legacy-completions-auth',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/auth/`,
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/types/src/auth.ts`,
    ],
    replacement: 'CompletionModelReference credentials supplied by the local model adapter.',
    rationale: 'Legacy Copilot token acquisition and LSP auth notifications are not used by this extension.',
  },
  {
    id: 'configured-completions-transport',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/openai/fetch.ts`,
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/networkConfiguration.ts`,
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/networking.ts`,
    ],
    replacement: 'CompletionModel and LanguageModelChat streaming adapters.',
    rationale: 'Request transport, endpoints, and authentication are owned by the configured provider.',
  },
  {
    id: 'configured-completions-model-selection',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/openai/model.ts`,
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/extension/src/modelPickerUserSelection.ts`,
    ],
    replacement: 'CompletionModelReference selected by Unify Chat Provider configuration.',
    rationale: 'The Copilot model picker and token-driven model manager are host UI concerns.',
  },
  {
    id: 'legacy-snippy-service',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/snippy/`,
    ],
    replacement: 'No-op citation-network adapter and local completion lifecycle handling.',
    rationale: 'Legacy Snippy network, connection UI, and telemetry do not generate completion content.',
  },
  {
    id: 'local-behavior-configuration',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}platform/configuration/common/configurationService.ts`,
      `${COPILOT_SOURCE_ROOT}platform/telemetry/common/nullExperimentationService.ts`,
    ],
    replacement: 'Commit-pinned local behavior configuration.',
    rationale: 'Remote experiments and Copilot settings are outside the allowed architecture boundary.',
  },
  {
    id: 'local-observability',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/bridge/src/completionsTelemetryServiceBridge.ts`,
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/telemetry/userConfig.ts`,
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/test/`,
      `${COPILOT_SOURCE_ROOT}platform/requestLogger/`,
      `${COPILOT_SOURCE_ROOT}platform/survey/`,
      `${COPILOT_SOURCE_ROOT}platform/telemetry/`,
    ],
    replacement: 'Local logger/no-op upload adapters while preserving algorithm state transitions.',
    rationale: 'Official telemetry upload is excluded, but state-changing callers remain extracted.',
  },
  {
    id: 'host-contribution-wiring',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}extension/common/contributions.ts`,
      `${COPILOT_SOURCE_ROOT}extension/completions/vscode-node/completionsCoreContribution.ts`,
      `${COPILOT_SOURCE_ROOT}extension/completions/vscode-node/completionsUnificationContribution.ts`,
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/completionsServiceBridges.ts`,
    ],
    replacement: 'CompletionManager and persistent CopilotRuntime registration.',
    rationale: 'The project intentionally exposes one outer inline completion provider.',
  },
  {
    id: 'debug-and-feedback-ui',
    sourcePrefixes: [
      `${COPILOT_SOURCE_ROOT}extension/inlineEdits/vscode-node/components/expectedEditCaptureController.ts`,
      `${COPILOT_SOURCE_ROOT}extension/inlineEdits/vscode-node/components/inlineEditDebugComponent.ts`,
      `${COPILOT_SOURCE_ROOT}extension/inlineEdits/vscode-node/components/logContextRecorder.ts`,
    ],
    replacement: 'No-op debug/feedback UI adapters.',
    rationale: 'These modules collect diagnostics or UI feedback and do not generate completion content.',
  },
];

export const CHAT_LIB_FORBIDDEN_SNAPSHOT_SOURCE_PREFIXES = [
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/auth/`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/types/src/auth.ts`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/openai/fetch.ts`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/openai/model.ts`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/networkConfiguration.ts`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/networking.ts`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/snippy/`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/bridge/src/completionsTelemetryServiceBridge.ts`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/extension/src/modelPickerUserSelection.ts`,
  `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/lib/src/test/`,
  `${COPILOT_SOURCE_ROOT}platform/authentication/`,
  `${COPILOT_SOURCE_ROOT}platform/networking/`,
  `${COPILOT_SOURCE_ROOT}extension/copilotPanel/`,
  `${COPILOT_SOURCE_ROOT}extension/webView/`,
] as const;

export interface ChatLibDynamicResourceAudit {
  sourcePath: string;
  markers: readonly string[];
  resolution: string;
}

export const CHAT_LIB_DYNAMIC_RESOURCE_AUDITS: readonly ChatLibDynamicResourceAudit[] = [
  {
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/prompt/src/fileLoader.ts`,
    markers: ['__dirname', 'locateFile('],
    resolution: 'Generic dist resource locator; tokenizer and parser callers have explicit resource declarations.',
  },
  {
    sourcePath:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/prompt/src/parse.ts`,
    markers: ['locateFile('],
    resolution: 'Tree-sitter runtime and supported grammars are declared as exact package resources.',
  },
];

export interface ChatLibExternalResource {
  loadedBy: string;
  packageName: string;
  expectedVersion: string;
  resourcePaths: readonly string[];
  reason: string;
}

export const CHAT_LIB_EXTERNAL_RESOURCES: readonly ChatLibExternalResource[] = [
  {
    loadedBy:
      `${COPILOT_SOURCE_ROOT}extension/completions-core/vscode-node/prompt/src/parse.ts`,
    packageName: '@vscode/tree-sitter-wasm',
    expectedVersion: '0.0.5-php.2',
    resourcePaths: CHAT_LIB_TREE_SITTER_WASM_FILES.map(
      (file) => `wasm/${file}`,
    ),
    reason:
      'The files are installed from the exact upstream package and are not Git blobs in microsoft/vscode.',
  },
];

export function planChatLibSnapshotPath(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, '/');
  if (!normalized.startsWith(`${COPILOT_ROOT}/`)) {
    throw new Error(
      `Copilot source path ${sourcePath} is outside ${COPILOT_ROOT}`,
    );
  }
  const relative = normalized.startsWith(COPILOT_SOURCE_ROOT)
    ? normalized.slice(COPILOT_SOURCE_ROOT.length)
    : path.posix.join(
        '_extension',
        normalized.slice(`${COPILOT_ROOT}/`.length),
      );
  if (!relative || relative.split('/').includes('..')) {
    throw new Error(`Invalid Copilot source path: ${sourcePath}`);
  }
  return path.posix.join(CHAT_LIB_SNAPSHOT_ROOT, relative);
}

export function rewriteChatLibSnapshotSource(
  content: string,
  sourcePath: string,
  commit: string,
): string {
  const normalized = normalizeLineEndings(content);
  const origin = provenanceHeader(sourcePath, commit);
  return normalized.startsWith(origin) ? normalized : `${origin}${normalized}`;
}

export function provenanceHeader(sourcePath: string, commit: string): string {
  return `// Generated from microsoft/vscode@${commit}: ${sourcePath}\n`;
}

export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function resolveRelativeImportCandidates(
  importer: string,
  specifier: string,
): string[] {
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  const extension = path.posix.extname(joined);
  const base = /\.(?:js|mjs|cjs)$/.test(extension)
    ? joined.slice(0, -extension.length)
    : joined;
  const candidates = extension && !/\.(?:js|mjs|cjs)$/.test(extension)
    ? [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}.d.ts`]
    : [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.d.ts`,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.json`,
        path.posix.join(base, 'index.ts'),
        path.posix.join(base, 'index.tsx'),
        path.posix.join(base, 'index.js'),
      ];
  return [...new Set(candidates)];
}

export function findBoundaryRule(
  sourcePath: string,
): ChatLibBoundaryRule | undefined {
  return CHAT_LIB_BOUNDARY_RULES.find((rule) =>
    rule.sourcePrefixes.some(
      (prefix) => sourcePath === prefix || sourcePath.startsWith(prefix),
    ),
  );
}

export function externalPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0] ?? specifier;
}
