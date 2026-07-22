import { builtinModules } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import * as ts from 'typescript';
import {
  CHAT_LIB_BOUNDARY_RULES,
  CHAT_LIB_DYNAMIC_RESOURCE_AUDITS,
  CHAT_LIB_EXTERNAL_RESOURCES,
  CHAT_LIB_FORBIDDEN_SNAPSHOT_SOURCE_PREFIXES,
  CHAT_LIB_RUNTIME_ENTRIES,
  CHAT_LIB_SNAPSHOT_ROOT,
  COPILOT_ROOT,
  COPILOT_SOURCE_ROOT,
  externalPackageName,
  findBoundaryRule,
  planChatLibSnapshotPath,
  resolveRelativeImportCandidates,
  rewriteChatLibSnapshotSource,
  sha256,
} from './chat-lib-extract-utils';
import { patchChatLibDiffSource } from './chat-lib-diff-patches';
import { patchChatLibParserSource } from './chat-lib-parser-patches';

const DEFAULT_REPOSITORY = 'https://github.com/microsoft/vscode.git';
const DEFAULT_REF = '1.128.0';
const MANIFEST_SCHEMA_VERSION = 1;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface AliasMapping {
  alias: string;
  target: string;
  wildcard: boolean;
}

type DependencyKind = 'source' | 'resource' | 'boundary' | 'external';

interface DependencyRecord {
  specifier: string;
  kind: DependencyKind;
  target?: string;
  boundaryId?: string;
  externalPackage?: string;
  externalProvider?: 'node' | 'vscode' | 'upstream-package';
  reason?: string;
}

interface SourceNode {
  sourcePath: string;
  kind: 'source' | 'resource';
  original: string;
  dependencies: DependencyRecord[];
  runtimeEntries: Set<string>;
}

interface DeclaredPackage {
  name: string;
  section: 'dependencies' | 'devDependencies' | 'optionalDependencies';
  version: string;
}

interface PortedRuntimeModule {
  runtimeFile: string;
  upstreamSources: string[];
  status: string;
  adaptation: string;
}

interface HostAdapterModule {
  runtimeFile: string;
  upstreamSources: string[];
  replaces: string[];
  adaptation: string;
}

interface PortingManifest {
  schemaVersion: number;
  upstreamCommit: string;
  runtimeModules: PortedRuntimeModule[];
  adapterModules: HostAdapterModule[];
  compiledUpstreamSources: string[];
}

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    ref: { type: 'string', default: DEFAULT_REF },
    output: { type: 'string', default: CHAT_LIB_SNAPSHOT_ROOT },
  },
});

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const ref = values.ref ?? DEFAULT_REF;
  const outputRoot = path.resolve(
    workspaceRoot,
    values.output ?? CHAT_LIB_SNAPSHOT_ROOT,
  );
  let sourceRoot = values.source ? path.resolve(values.source) : undefined;
  let temporaryClone: string | undefined;
  let temporaryOutput: string | undefined;

  try {
    if (!sourceRoot) {
      temporaryClone = await mkdtemp(path.join(tmpdir(), 'ucp-vscode-'));
      await run('git', [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        DEFAULT_REPOSITORY,
        temporaryClone,
      ]);
      sourceRoot = temporaryClone;
    }

    const repositoryRoot = sourceRoot;
    const commit = (
      await run('git', ['-C', repositoryRoot, 'rev-parse', `${ref}^{commit}`])
    ).stdout.trim();
    const sourceCommitDate = (
      await run('git', [
        '-C',
        repositoryRoot,
        'show',
        '-s',
        '--format=%cI',
        commit,
      ])
    ).stdout.trim();
    const readSource = (file: string): Promise<string> =>
      readGitFile(repositoryRoot, commit, file);
    const portingManifest = parsePortingManifest(
      JSON.parse(
        await readFile(
          path.resolve(workspaceRoot, 'src/chat-lib/porting-manifest.json'),
          'utf8',
        ),
      ),
    );
    if (portingManifest.upstreamCommit !== commit) {
      throw new Error(
        `Porting manifest commit ${portingManifest.upstreamCommit} does not match ${commit}.`,
      );
    }

    const aliases = parseAliasMappings(
      await readSource(`${COPILOT_ROOT}/tsconfig.json`),
    );
    const declaredPackages = parseDeclaredPackages(
      await readSource(`${COPILOT_ROOT}/package.json`),
    );
    const graph = await collectDependencies(
      readSource,
      aliases,
      declaredPackages,
      workspaceRoot,
    );
    assertNoForbiddenSnapshotSources(graph);
    attributeRuntimeEntries(graph);
    const dynamicResourceAudits = auditDynamicResources(graph);
    const externalResources = collectExternalResources(graph, declaredPackages);
    await validatePortingManifest(portingManifest, graph, readSource, workspaceRoot);

    const outputParent = path.dirname(outputRoot);
    await mkdir(outputParent, { recursive: true });
    temporaryOutput = await mkdtemp(
      path.join(outputParent, '.ucp-chat-lib-'),
    );
    const stagingRoot = path.join(temporaryOutput, 'snapshot');
    await mkdir(stagingRoot, { recursive: true });

    const moduleManifest = [];
    for (const node of [...graph.values()].sort(compareSourceNodes)) {
      const snapshotPath = planChatLibSnapshotPath(node.sourcePath);
      const relativePath = snapshotPath.slice(CHAT_LIB_SNAPSHOT_ROOT.length + 1);
      const destination = path.join(stagingRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      const snapshotContent = node.kind === 'source'
        ? rewriteChatLibSnapshotSource(node.original, node.sourcePath, commit)
        : node.original;
      await writeFile(destination, snapshotContent);
      moduleManifest.push({
        sourcePath: node.sourcePath,
        snapshotPath,
        kind: node.kind,
        runtimeEntries: [...node.runtimeEntries].sort(),
        sourceSha256: sha256(node.original),
        snapshotSha256: sha256(snapshotContent),
        importedBy: findImporters(graph, node.sourcePath),
        dependencies: [...node.dependencies].sort(compareDependencies),
      });
    }

    const externalDependencies = collectExternalDependencies(graph);
    const boundaryDependencies = collectBoundaryDependencies(graph);
    const dependencyManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      repository: DEFAULT_REPOSITORY,
      ref,
      commit,
      runtimeEntries: CHAT_LIB_RUNTIME_ENTRIES,
      modules: moduleManifest,
      externalDependencies,
      boundaryDependencies,
      dynamicResourceAudits,
      externalResources,
    };
    await writeJson(
      path.join(stagingRoot, 'dependency-manifest.json'),
      dependencyManifest,
    );

    const rewriteLedger = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      repository: DEFAULT_REPOSITORY,
      ref,
      commit,
      mechanicalRewrites: [
        {
          id: 'snapshot-path',
          operation: `Map ${COPILOT_SOURCE_ROOT}** to ${CHAT_LIB_SNAPSHOT_ROOT}/**.`,
          behaviorChange: false,
        },
        {
          id: 'line-endings',
          operation: 'Normalize copied TypeScript/JavaScript source line endings to LF.',
          behaviorChange: false,
        },
        {
          id: 'provenance-header',
          operation: 'Prepend copied source with its repository commit and exact source path.',
          behaviorChange: false,
        },
        {
          id: 'parser-runtime-strict-types',
          operation:
            'For the parser runtime bundle only, replace blockTrimmer.ts host document type imports with equivalent local structural interfaces and add an explicit undefined return to parseBlock.ts.',
          behaviorChange: false,
        },
        {
          id: 'diff-runtime-strict-types',
          operation:
            'For the diff runtime bundle only, remove unreachable move/text-edit APIs and replace broad host dependencies with equivalent local structural helpers.',
          behaviorChange: false,
        },
      ],
      importRewrites: [],
      serviceReplacements: CHAT_LIB_BOUNDARY_RULES.map((rule) => ({
        id: rule.id,
        upstreamPaths: rule.sourcePrefixes,
        replacement: rule.replacement,
        rationale: rule.rationale,
        behaviorChange: true,
      })),
      portingManifest: 'src/chat-lib/porting-manifest.json',
      behaviorPatches: portingManifest.runtimeModules,
      hostAdapters: portingManifest.adapterModules,
      adapterFiles: portingManifest.adapterModules
        .map((item) => item.runtimeFile)
        .sort(),
      runtimeFiles: [
        ...portingManifest.runtimeModules.map((item) => item.runtimeFile),
        ...portingManifest.compiledUpstreamSources.map(planChatLibSnapshotPath),
      ].sort(),
      forbiddenPatterns: [
        `as${' '}any`,
        `@ts-${'ignore'}`,
        `@ts-${'nocheck'}`,
      ],
    };
    await writeJson(path.join(stagingRoot, 'rewrite-ledger.json'), rewriteLedger);

    const sourceMetadata = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      repository: DEFAULT_REPOSITORY,
      ref,
      commit,
      sourceCommitDate,
      entryPoints: CHAT_LIB_RUNTIME_ENTRIES,
      sourceModuleCount: moduleManifest.filter((item) => item.kind === 'source').length,
      resourceCount: moduleManifest.filter((item) => item.kind === 'resource').length,
      extractionRules: [
        'Start only from upstream modules that are compiled or bundled into the extension runtime.',
        'Apply the same parser/diff build transforms before following TypeScript imports so unreachable host-only dependencies are not retained.',
        'Follow every remaining TypeScript static import/export and triple-slash source reference.',
        'Resolve relative imports and extensions/copilot/tsconfig.json path aliases.',
        'Fail on unresolved source imports and undeclared external packages.',
        'Keep manual-port and host-adapter provenance in src/chat-lib/porting-manifest.json without retaining their full source closure.',
        'Include declared implicit worker and tokenizer resource dependencies.',
        'Attribute every retained module/resource to at least one runtime entry.',
      ],
      manifest: 'dependency-manifest.json',
      rewriteLedger: 'rewrite-ledger.json',
    };
    await writeJson(path.join(stagingRoot, 'source.json'), sourceMetadata);
    await writeFile(
      path.join(stagingRoot, 'README.md'),
      [
        '# VS Code Copilot core source snapshot',
        '',
        'Generated by `npm run extract:chat-lib` as part of the atomic upstream update workflow.',
        'The workflow refreshes only the runtime dependency closure, then verifies provenance, boundaries, and strict types and builds and smoke-tests the runtime bundles before publishing the candidate.',
        '`dependency-manifest.json` attributes the compiled and bundled runtime closure and records every dependency edge.',
        '`rewrite-ledger.json` records mechanical rewrites, host service boundaries, and temporary behavior patches.',
        'Run `npm run verify:chat-lib` independently after manual core ports or manifest/provenance changes.',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(stagingRoot, 'LICENSE.txt'),
      await readGitFile(repositoryRoot, commit, `${COPILOT_ROOT}/chat-lib/LICENSE.txt`),
    );

    await rm(outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, outputRoot);
    console.log(
      `Extracted ${moduleManifest.length} attributed files from microsoft/vscode@${commit}.`,
    );
  } finally {
    if (temporaryOutput) {
      await rm(temporaryOutput, { recursive: true, force: true });
    }
    if (temporaryClone) {
      await rm(temporaryClone, { recursive: true, force: true });
    }
  }
}

function assertNoForbiddenSnapshotSources(
  graph: ReadonlyMap<string, SourceNode>,
): void {
  const forbidden = [...graph.keys()].filter((sourcePath) =>
    CHAT_LIB_FORBIDDEN_SNAPSHOT_SOURCE_PREFIXES.some(
      (prefix) => sourcePath === prefix || sourcePath.startsWith(prefix),
    ),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Extracted graph crosses forbidden host boundary: ${forbidden.sort().join(', ')}`,
    );
  }
}

async function collectDependencies(
  readSource: (file: string) => Promise<string>,
  aliases: readonly AliasMapping[],
  declaredPackages: ReadonlyMap<string, DeclaredPackage>,
  workspaceRoot: string,
): Promise<Map<string, SourceNode>> {
  const graph = new Map<string, SourceNode>();
  const queued = CHAT_LIB_RUNTIME_ENTRIES.map((entry) => entry.sourcePath);
  const existence = new Map<string, boolean>();

  const exists = async (candidate: string): Promise<boolean> => {
    const cached = existence.get(candidate);
    if (cached !== undefined) {
      return cached;
    }
    try {
      await readSource(candidate);
      existence.set(candidate, true);
      return true;
    } catch {
      existence.set(candidate, false);
      return false;
    }
  };

  while (queued.length > 0) {
    const sourcePath = queued.shift();
    if (!sourcePath || graph.has(sourcePath)) {
      continue;
    }
    const original = await readSource(sourcePath);
    const node: SourceNode = {
      sourcePath,
      kind: isSourceCode(sourcePath) ? 'source' : 'resource',
      original,
      dependencies: [],
      runtimeEntries: new Set<string>(),
    };
    graph.set(sourcePath, node);

    if (node.kind === 'source') {
      const snapshotPath = path.resolve(
        workspaceRoot,
        planChatLibSnapshotPath(sourcePath),
      );
      const runtimeSource = patchChatLibDiffSource(
        snapshotPath,
        patchChatLibParserSource(snapshotPath, original),
      );
      const preprocessed = ts.preProcessFile(runtimeSource, true, true);
      for (const imported of preprocessed.importedFiles) {
        const dependency = await resolveDependency(
          sourcePath,
          imported.fileName,
          aliases,
          declaredPackages,
          exists,
        );
        node.dependencies.push(dependency);
        if (
          (dependency.kind === 'source' || dependency.kind === 'resource') &&
          dependency.target &&
          !graph.has(dependency.target)
        ) {
          queued.push(dependency.target);
        }
      }
      for (const reference of preprocessed.referencedFiles) {
        const dependency = await resolveInternalDependency(
          sourcePath,
          reference.fileName,
          aliases,
          exists,
          'triple-slash reference',
        );
        node.dependencies.push(dependency);
        if (dependency.target && !graph.has(dependency.target)) {
          queued.push(dependency.target);
        }
      }
      for (const typeReference of preprocessed.typeReferenceDirectives) {
        const packageName = typeReference.fileName.startsWith('@types/')
          ? externalPackageName(typeReference.fileName)
          : `@types/${externalPackageName(typeReference.fileName)}`;
        if (!declaredPackages.has(packageName)) {
          throw new Error(
            `${sourcePath} references undeclared type package ${typeReference.fileName}.`,
          );
        }
        node.dependencies.push({
          specifier: typeReference.fileName,
          kind: 'external',
          externalPackage: packageName,
          externalProvider: 'upstream-package',
          reason: 'triple-slash type reference',
        });
      }
    }

    node.dependencies = deduplicateDependencies(node.dependencies);
  }

  return graph;
}

async function resolveDependency(
  importer: string,
  specifier: string,
  aliases: readonly AliasMapping[],
  declaredPackages: ReadonlyMap<string, DeclaredPackage>,
  exists: (candidate: string) => Promise<boolean>,
): Promise<DependencyRecord> {
  if (specifier.startsWith('.') || findAlias(specifier, aliases)) {
    return resolveInternalDependency(
      importer,
      specifier,
      aliases,
      exists,
      'static import',
    );
  }

  const normalized = specifier.replace(/^node:/, '');
  if (builtinModules.includes(normalized)) {
    return {
      specifier,
      kind: 'external',
      externalPackage: normalized,
      externalProvider: 'node',
    };
  }
  if (specifier === 'vscode') {
    return {
      specifier,
      kind: 'external',
      externalPackage: 'vscode',
      externalProvider: 'vscode',
    };
  }

  const packageName = externalPackageName(specifier);
  const declared = declaredPackages.get(packageName);
  if (!declared) {
    throw new Error(
      `${importer} imports undeclared external package ${specifier}. ` +
        'Declare it upstream or add an explicit host-service boundary.',
    );
  }
  return {
    specifier,
    kind: 'external',
    externalPackage: packageName,
    externalProvider: 'upstream-package',
    reason: `declared in upstream ${declared.section}`,
  };
}

async function resolveInternalDependency(
  importer: string,
  specifier: string,
  aliases: readonly AliasMapping[],
  exists: (candidate: string) => Promise<boolean>,
  reason: string,
): Promise<DependencyRecord> {
  const candidates = resolveImportCandidates(importer, specifier, aliases);
  for (const candidate of candidates) {
    if (!(await exists(candidate))) {
      continue;
    }
    const boundary = findBoundaryRule(candidate);
    if (boundary) {
      return {
        specifier,
        kind: 'boundary',
        target: candidate,
        boundaryId: boundary.id,
        reason,
      };
    }
    return {
      specifier,
      kind: isSourceCode(candidate) ? 'source' : 'resource',
      target: candidate,
      reason,
    };
  }
  throw new Error(
    `Unresolved ${reason} ${specifier} from ${importer}. Tried: ${candidates.join(', ')}`,
  );
}

function resolveImportCandidates(
  importer: string,
  specifier: string,
  aliases: readonly AliasMapping[],
): string[] {
  if (specifier.startsWith('.')) {
    return resolveRelativeImportCandidates(importer, specifier);
  }
  const mapping = findAlias(specifier, aliases);
  if (!mapping) {
    return [];
  }
  const remainder = mapping.wildcard
    ? specifier.slice(mapping.alias.length + 1)
    : '';
  const target = path.posix.join(COPILOT_ROOT, mapping.target, remainder);
  return resolveRelativeImportCandidates(
    `${COPILOT_ROOT}/__alias_importer__.ts`,
    `./${path.posix.relative(COPILOT_ROOT, target)}`,
  );
}

function findAlias(
  specifier: string,
  aliases: readonly AliasMapping[],
): AliasMapping | undefined {
  return aliases.find((mapping) =>
    mapping.wildcard
      ? specifier.startsWith(`${mapping.alias}/`)
      : specifier === mapping.alias,
  );
}

function parseAliasMappings(tsconfigText: string): AliasMapping[] {
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText);
  if (parsed.error) {
    throw new Error('Unable to parse Copilot tsconfig.json.');
  }
  const config: unknown = parsed.config;
  if (!isRecord(config) || !isRecord(config.compilerOptions)) {
    return [];
  }
  const paths = config.compilerOptions.paths;
  if (!isRecord(paths)) {
    return [];
  }

  const mappings: AliasMapping[] = [];
  for (const [rawAlias, rawTargets] of Object.entries(paths)) {
    if (rawAlias === 'vscode' || !Array.isArray(rawTargets)) {
      continue;
    }
    const first = rawTargets.find(
      (target): target is string => typeof target === 'string',
    );
    if (!first) {
      continue;
    }
    mappings.push({
      alias: rawAlias.replace(/\/\*$/, ''),
      target: first.replace(/^\.\//, '').replace(/\/\*$/, ''),
      wildcard: rawAlias.endsWith('/*'),
    });
  }
  return mappings.sort((left, right) => right.alias.length - left.alias.length);
}

function parseDeclaredPackages(text: string): Map<string, DeclaredPackage> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('Unable to parse upstream package.json.');
  }
  const result = new Map<string, DeclaredPackage>();
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ] as const) {
    const values = parsed[section];
    if (!isRecord(values)) {
      continue;
    }
    for (const name of Object.keys(values).sort()) {
      const version = values[name];
      if (typeof version !== 'string') {
        throw new Error(`Upstream ${section}.${name} must be a string version.`);
      }
      result.set(name, { name, section, version });
    }
  }
  return result;
}

function parsePortingManifest(value: unknown): PortingManifest {
  if (!isRecord(value)) {
    throw new Error('src/chat-lib/porting-manifest.json must be an object.');
  }
  const {
    schemaVersion,
    upstreamCommit,
    runtimeModules,
    adapterModules,
    compiledUpstreamSources,
  } = value;
  if (
    typeof schemaVersion !== 'number' ||
    typeof upstreamCommit !== 'string' ||
    !Array.isArray(runtimeModules) ||
    !Array.isArray(adapterModules) ||
    !Array.isArray(compiledUpstreamSources)
  ) {
    throw new Error('Invalid src/chat-lib/porting-manifest.json header.');
  }
  const parsedModules = runtimeModules.map((item, index): PortedRuntimeModule => {
    if (!isRecord(item)) {
      throw new Error(`Porting manifest runtimeModules[${index}] must be an object.`);
    }
    const { runtimeFile, upstreamSources, status, adaptation } = item;
    if (
      typeof runtimeFile !== 'string' ||
      !Array.isArray(upstreamSources) ||
      !upstreamSources.every((source): source is string => typeof source === 'string') ||
      typeof status !== 'string' ||
      typeof adaptation !== 'string'
    ) {
      throw new Error(`Invalid porting manifest runtimeModules[${index}].`);
    }
    return { runtimeFile, upstreamSources, status, adaptation };
  });
  const parsedAdapters = adapterModules.map((item, index): HostAdapterModule => {
    if (!isRecord(item)) {
      throw new Error(`Porting manifest adapterModules[${index}] must be an object.`);
    }
    const { runtimeFile, upstreamSources, replaces, adaptation } = item;
    if (
      typeof runtimeFile !== 'string' ||
      !Array.isArray(upstreamSources) ||
      !upstreamSources.every((source): source is string => typeof source === 'string') ||
      !Array.isArray(replaces) ||
      !replaces.every((replacement): replacement is string => typeof replacement === 'string') ||
      typeof adaptation !== 'string'
    ) {
      throw new Error(`Invalid porting manifest adapterModules[${index}].`);
    }
    return { runtimeFile, upstreamSources, replaces, adaptation };
  });
  if (!compiledUpstreamSources.every(
    (source): source is string => typeof source === 'string',
  )) {
    throw new Error('Porting manifest compiledUpstreamSources must contain strings.');
  }
  return {
    schemaVersion,
    upstreamCommit,
    runtimeModules: parsedModules,
    adapterModules: parsedAdapters,
    compiledUpstreamSources,
  };
}

async function validatePortingManifest(
  manifest: PortingManifest,
  graph: ReadonlyMap<string, SourceNode>,
  readSource: (file: string) => Promise<string>,
  workspaceRoot: string,
): Promise<void> {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported porting manifest schema ${manifest.schemaVersion}.`);
  }
  const runtimeFiles = new Set<string>();
  for (const module of manifest.runtimeModules) {
    if (runtimeFiles.has(module.runtimeFile)) {
      throw new Error(`Duplicate porting manifest runtime file ${module.runtimeFile}.`);
    }
    runtimeFiles.add(module.runtimeFile);
    const absolute = path.resolve(workspaceRoot, module.runtimeFile);
    if (!absolute.startsWith(`${path.resolve(workspaceRoot, 'src/chat-lib')}${path.sep}`)) {
      throw new Error(`Porting manifest runtime file escapes src/chat-lib: ${module.runtimeFile}.`);
    }
    await readFile(absolute, 'utf8');
    if (module.upstreamSources.length === 0 || module.adaptation.trim().length === 0) {
      throw new Error(`${module.runtimeFile} has no upstream source or adaptation rationale.`);
    }
    for (const source of module.upstreamSources) {
      await readSource(source);
    }
  }
  for (const adapter of manifest.adapterModules) {
    if (runtimeFiles.has(adapter.runtimeFile)) {
      throw new Error(`Duplicate porting manifest file ${adapter.runtimeFile}.`);
    }
    runtimeFiles.add(adapter.runtimeFile);
    const absolute = path.resolve(workspaceRoot, adapter.runtimeFile);
    const adapterRoot = path.resolve(workspaceRoot, 'src/completion');
    if (!absolute.startsWith(`${adapterRoot}${path.sep}`)) {
      throw new Error(
        `Porting manifest adapter escapes src/completion: ${adapter.runtimeFile}.`,
      );
    }
    await readFile(absolute, 'utf8');
    if (
      adapter.upstreamSources.length === 0 ||
      adapter.replaces.length === 0 ||
      adapter.adaptation.trim().length === 0
    ) {
      throw new Error(`${adapter.runtimeFile} has incomplete adapter provenance.`);
    }
    for (const source of adapter.upstreamSources) {
      await readSource(source);
    }
  }
  for (const source of manifest.compiledUpstreamSources) {
    if (!graph.has(source)) {
      throw new Error(`Compiled upstream runtime source ${source} is absent from the extracted graph.`);
    }
  }
}

function attributeRuntimeEntries(graph: Map<string, SourceNode>): void {
  for (const entry of CHAT_LIB_RUNTIME_ENTRIES) {
    const visited = new Set<string>();
    const queued = [entry.sourcePath];
    while (queued.length > 0) {
      const sourcePath = queued.pop();
      if (!sourcePath || visited.has(sourcePath)) {
        continue;
      }
      visited.add(sourcePath);
      const node = graph.get(sourcePath);
      if (!node) {
        throw new Error(`Runtime entry dependency ${sourcePath} was not extracted.`);
      }
      node.runtimeEntries.add(entry.id);
      for (const dependency of node.dependencies) {
        if (
          (dependency.kind === 'source' || dependency.kind === 'resource') &&
          dependency.target
        ) {
          queued.push(dependency.target);
        }
      }
    }
  }
  const unattributed = [...graph.values()]
    .filter((node) => node.runtimeEntries.size === 0)
    .map((node) => node.sourcePath);
  if (unattributed.length > 0) {
    throw new Error(`Extracted files have no runtime entry: ${unattributed.join(', ')}`);
  }
}

function auditDynamicResources(graph: ReadonlyMap<string, SourceNode>) {
  const suspiciousMarkers = [
    '__dirname',
    'locateFile(',
    'new Worker(',
    'new WorkerWithRpcProxy',
    'readFileSync(',
    'require(',
  ];
  const rules = new Map(
    CHAT_LIB_DYNAMIC_RESOURCE_AUDITS.map((audit) => [audit.sourcePath, audit]),
  );
  const used = [];
  for (const node of graph.values()) {
    if (node.kind !== 'source') {
      continue;
    }
    const detected = suspiciousMarkers.filter((marker) =>
      node.original.includes(marker),
    );
    if (detected.length === 0) {
      continue;
    }
    const audit = rules.get(node.sourcePath);
    if (!audit) {
      throw new Error(
        `${node.sourcePath} performs dynamic resource loading (${detected.join(', ')}) ` +
          'without an explicit audit rule.',
      );
    }
    for (const marker of detected) {
      if (!audit.markers.includes(marker)) {
        throw new Error(
          `${node.sourcePath} has unaudited dynamic resource marker ${marker}.`,
        );
      }
    }
    for (const marker of audit.markers) {
      if (!node.original.includes(marker)) {
        throw new Error(
          `${node.sourcePath} dynamic resource audit marker ${marker} is stale.`,
        );
      }
    }
    used.push({
      sourcePath: audit.sourcePath,
      markers: audit.markers,
      resolution: audit.resolution,
      runtimeEntries: [...node.runtimeEntries].sort(),
    });
  }
  return used.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function collectExternalResources(
  graph: ReadonlyMap<string, SourceNode>,
  declaredPackages: ReadonlyMap<string, DeclaredPackage>,
) {
  const result = [];
  for (const resource of CHAT_LIB_EXTERNAL_RESOURCES) {
    const loader = graph.get(resource.loadedBy);
    if (!loader) {
      continue;
    }
    const declared = declaredPackages.get(resource.packageName);
    if (!declared) {
      throw new Error(
        `${resource.loadedBy} requires undeclared resource package ${resource.packageName}.`,
      );
    }
    if (declared.version !== resource.expectedVersion) {
      throw new Error(
        `${resource.packageName} resource rule expects ${resource.expectedVersion}, ` +
          `but upstream declares ${declared.version}.`,
      );
    }
    result.push({
      loadedBy: resource.loadedBy,
      package: resource.packageName,
      version: declared.version,
      resourcePaths: resource.resourcePaths,
      reason: resource.reason,
      runtimeEntries: [...loader.runtimeEntries].sort(),
    });
  }
  return result.sort((left, right) => left.loadedBy.localeCompare(right.loadedBy));
}

function collectExternalDependencies(graph: ReadonlyMap<string, SourceNode>) {
  const aggregated = new Map<string, {
    specifier: string;
    package: string;
    provider: string;
    importers: Set<string>;
    runtimeEntries: Set<string>;
  }>();
  for (const node of graph.values()) {
    for (const dependency of node.dependencies) {
      if (
        dependency.kind !== 'external' ||
        !dependency.externalPackage ||
        !dependency.externalProvider
      ) {
        continue;
      }
      const key = `${dependency.externalProvider}\0${dependency.specifier}`;
      const current = aggregated.get(key) ?? {
        specifier: dependency.specifier,
        package: dependency.externalPackage,
        provider: dependency.externalProvider,
        importers: new Set<string>(),
        runtimeEntries: new Set<string>(),
      };
      current.importers.add(node.sourcePath);
      for (const entry of node.runtimeEntries) {
        current.runtimeEntries.add(entry);
      }
      aggregated.set(key, current);
    }
  }
  return [...aggregated.values()]
    .map((item) => ({
      specifier: item.specifier,
      package: item.package,
      provider: item.provider,
      importers: [...item.importers].sort(),
      runtimeEntries: [...item.runtimeEntries].sort(),
    }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
}

function collectBoundaryDependencies(graph: ReadonlyMap<string, SourceNode>) {
  const aggregated = new Map<string, {
    boundaryId: string;
    target: string;
    importers: Set<string>;
    runtimeEntries: Set<string>;
  }>();
  for (const node of graph.values()) {
    for (const dependency of node.dependencies) {
      if (
        dependency.kind !== 'boundary' ||
        !dependency.boundaryId ||
        !dependency.target
      ) {
        continue;
      }
      const key = `${dependency.boundaryId}\0${dependency.target}`;
      const current = aggregated.get(key) ?? {
        boundaryId: dependency.boundaryId,
        target: dependency.target,
        importers: new Set<string>(),
        runtimeEntries: new Set<string>(),
      };
      current.importers.add(node.sourcePath);
      for (const entry of node.runtimeEntries) {
        current.runtimeEntries.add(entry);
      }
      aggregated.set(key, current);
    }
  }
  return [...aggregated.values()]
    .map((item) => ({
      boundaryId: item.boundaryId,
      target: item.target,
      importers: [...item.importers].sort(),
      runtimeEntries: [...item.runtimeEntries].sort(),
    }))
    .sort((left, right) =>
      left.boundaryId.localeCompare(right.boundaryId) ||
      left.target.localeCompare(right.target),
    );
}

function findImporters(
  graph: ReadonlyMap<string, SourceNode>,
  sourcePath: string,
): string[] {
  return [...graph.values()]
    .filter((node) => node.dependencies.some(
      (dependency) =>
        (dependency.kind === 'source' || dependency.kind === 'resource') &&
        dependency.target === sourcePath,
    ))
    .map((node) => node.sourcePath)
    .sort();
}

function deduplicateDependencies(
  dependencies: readonly DependencyRecord[],
): DependencyRecord[] {
  const unique = new Map<string, DependencyRecord>();
  for (const dependency of dependencies) {
    const key = [
      dependency.specifier,
      dependency.kind,
      dependency.target ?? '',
      dependency.boundaryId ?? '',
      dependency.externalPackage ?? '',
    ].join('\0');
    unique.set(key, dependency);
  }
  return [...unique.values()].sort(compareDependencies);
}

function compareDependencies(
  left: DependencyRecord,
  right: DependencyRecord,
): number {
  return left.specifier.localeCompare(right.specifier) ||
    left.kind.localeCompare(right.kind) ||
    (left.target ?? '').localeCompare(right.target ?? '');
}

function compareSourceNodes(left: SourceNode, right: SourceNode): number {
  return left.sourcePath.localeCompare(right.sourcePath);
}

function isSourceCode(sourcePath: string): boolean {
  return /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(sourcePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readGitFile(
  repo: string,
  ref: string,
  file: string,
): Promise<string> {
  return (await run('git', ['-C', repo, 'show', `${ref}:${file}`])).stdout;
}

function run(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr}`,
          ),
        );
      }
    });
  });
}
