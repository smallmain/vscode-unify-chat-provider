import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  CHAT_LIB_BOUNDARY_RULES,
  CHAT_LIB_DYNAMIC_RESOURCE_AUDITS,
  CHAT_LIB_EXTERNAL_RESOURCES,
  CHAT_LIB_FORBIDDEN_SNAPSHOT_SOURCE_PREFIXES,
  CHAT_LIB_RUNTIME_ENTRIES,
  CHAT_LIB_SNAPSHOT_ROOT,
  planChatLibSnapshotPath,
  provenanceHeader,
  resolveRelativeImportCandidates,
  sha256,
} from './chat-lib-extract-utils';
import { verifyChatLibDiffClosure } from './chat-lib-diff-build';
import { verifyChatLibParserClosure } from './chat-lib-parser-build';

interface ManifestDependency {
  specifier: string;
  kind: 'source' | 'resource' | 'boundary' | 'external';
  target?: string;
  boundaryId?: string;
}

interface ManifestModule {
  sourcePath: string;
  snapshotPath: string;
  kind: 'source' | 'resource';
  runtimeEntries: string[];
  sourceSha256: string;
  snapshotSha256: string;
  importedBy: string[];
  dependencies: ManifestDependency[];
}

interface DependencyManifest {
  schemaVersion: number;
  repository: string;
  ref: string;
  commit: string;
  runtimeEntries: Array<{ id: string; sourcePath: string }>;
  modules: ManifestModule[];
  externalDependencies: Array<{
    specifier: string;
    importers: string[];
    runtimeEntries: string[];
  }>;
  boundaryDependencies: Array<{
    boundaryId: string;
    target: string;
    importers: string[];
    runtimeEntries: string[];
  }>;
  dynamicResourceAudits: Array<{
    sourcePath: string;
    markers: string[];
    resolution: string;
    runtimeEntries: string[];
  }>;
  externalResources: Array<{
    loadedBy: string;
    package: string;
    version: string;
    resourcePaths: string[];
    reason: string;
    runtimeEntries: string[];
  }>;
}

interface SourceMetadata {
  schemaVersion: number;
  repository: string;
  ref: string;
  commit: string;
  entryPoints: Array<{ id: string; sourcePath: string }>;
  sourceModuleCount: number;
  resourceCount: number;
  manifest: string;
  rewriteLedger: string;
}

interface RewriteLedger {
  schemaVersion: number;
  repository: string;
  ref: string;
  commit: string;
  portingManifest: string;
  behaviorPatches: PortedRuntimeModule[];
  hostAdapters: HostAdapterModule[];
  adapterFiles: string[];
  serviceReplacements: Array<{ id: string; upstreamPaths: string[] }>;
  runtimeFiles: string[];
  forbiddenPatterns: string[];
}

interface PortedRuntimeModule {
  runtimeFile: string;
  upstreamSources: string[];
  status: string;
  adaptation: string;
}

interface PortingManifest {
  schemaVersion: number;
  upstreamCommit: string;
  runtimeModules: PortedRuntimeModule[];
  adapterModules: HostAdapterModule[];
  compiledUpstreamSources: string[];
}

interface UpstreamIdentity {
  repository: string;
  ref: string;
  commit: string;
}

interface HostAdapterModule {
  runtimeFile: string;
  upstreamSources: string[];
  replaces: string[];
  adaptation: string;
}

const ALLOWED_AUXILIARY_FILES = new Set([
  'LICENSE.txt',
  'README.md',
  'dependency-manifest.json',
  'rewrite-ledger.json',
  'source.json',
]);

const FORBIDDEN_REFERENCE_PATH_PARTS = [
  '/authentication/',
  '/chatLibMain.ts',
  '/copilotPanel/',
  '/webView/',
];

const PRODUCTION_ENTRY_POINTS: readonly string[] = ['src/extension.ts'];

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const snapshotRoot = path.resolve(workspaceRoot, CHAT_LIB_SNAPSHOT_ROOT);
  const manifest = parseDependencyManifest(
    await readJson(path.join(snapshotRoot, 'dependency-manifest.json')),
  );
  const source = parseSourceMetadata(
    await readJson(path.join(snapshotRoot, 'source.json')),
  );
  const ledger = parseRewriteLedger(
    await readJson(path.join(snapshotRoot, 'rewrite-ledger.json')),
  );
  const porting = parsePortingManifest(
    await readJson(path.resolve(workspaceRoot, 'src/chat-lib/porting-manifest.json')),
  );
  const matrix = parseBehaviorMatrixUpstream(
    await readJson(path.resolve(workspaceRoot, 'test/parity/behavior-matrix.json')),
  );

  verifyMetadataAgreement(manifest, source, ledger, porting, matrix);
  await verifyManifestFiles(workspaceRoot, snapshotRoot, manifest);
  verifyDependencyAccounting(manifest, ledger);
  await verifyExternalResourceFiles(workspaceRoot, manifest);
  const productionClosure = await collectProductionRuntimeClosure(workspaceRoot);
  const runtimeClosure = new Set(
    [...productionClosure].filter(
      (file) =>
        file.startsWith('src/chat-lib/') &&
        /\.(?:ts|tsx)$/.test(file),
    ),
  );
  verifyRuntimeLedger(runtimeClosure, ledger);
  await verifyRuntimeSources(workspaceRoot, runtimeClosure, manifest, ledger);
  await verifyAdapterSources(
    workspaceRoot,
    productionClosure,
    porting.adapterModules,
    ledger,
  );
  await verifyDirectSnapshotImportAccounting(
    workspaceRoot,
    productionClosure,
    porting.adapterModules,
  );
  await verifyProductionRuntimeImports(workspaceRoot);
  await runStrictCompiler(workspaceRoot);
  verifyChatLibDiffClosure();
  verifyChatLibParserClosure();

  console.log(
    `Verified chat-lib: ${manifest.modules.length} attributed snapshot files, ` +
      `${runtimeClosure.size} strict runtime files, ` +
      `${porting.adapterModules.length} strict host adapters, commit ${manifest.commit}.`,
  );
}

function verifyMetadataAgreement(
  manifest: DependencyManifest,
  source: SourceMetadata,
  ledger: RewriteLedger,
  porting: PortingManifest,
  matrix: UpstreamIdentity,
): void {
  assert(manifest.schemaVersion === 1, 'Unsupported dependency manifest schema.');
  assert(source.schemaVersion === 1, 'Unsupported source metadata schema.');
  assert(ledger.schemaVersion === 1, 'Unsupported rewrite ledger schema.');
  assert(
    manifest.repository === source.repository &&
      manifest.repository === ledger.repository &&
      manifest.ref === source.ref &&
      manifest.ref === ledger.ref &&
      manifest.commit === source.commit &&
      manifest.commit === ledger.commit,
    'source.json, dependency manifest, and rewrite ledger provenance differ.',
  );
  assert(
    source.repository === matrix.repository &&
      source.ref === matrix.ref &&
      source.commit === matrix.commit,
    'Extracted provenance differs from the behavior matrix.',
  );
  assert(
    manifest.commit === porting.upstreamCommit,
    'Porting manifest commit differs from the extracted source commit.',
  );
  assert(ledger.portingManifest === 'src/chat-lib/porting-manifest.json', 'Unexpected porting manifest path.');
  assert(
    JSON.stringify(ledger.behaviorPatches) === JSON.stringify(porting.runtimeModules),
    'Generated rewrite ledger is stale relative to the porting manifest.',
  );
  assert(
    JSON.stringify(ledger.hostAdapters) === JSON.stringify(porting.adapterModules),
    'Generated host adapter ledger is stale relative to the porting manifest.',
  );
  assert(
    JSON.stringify(ledger.adapterFiles) ===
      JSON.stringify(porting.adapterModules.map((adapter) => adapter.runtimeFile).sort()),
    'Generated adapter file ledger is stale relative to the porting manifest.',
  );
  const expectedRuntimeFiles = [
    ...porting.runtimeModules.map((module) => module.runtimeFile),
    ...porting.compiledUpstreamSources.map(planChatLibSnapshotPath),
  ].sort();
  assert(
    JSON.stringify(ledger.runtimeFiles) === JSON.stringify(expectedRuntimeFiles),
    'Generated runtime file ledger is stale relative to the porting manifest.',
  );
  assert(source.manifest === 'dependency-manifest.json', 'Unexpected manifest path.');
  assert(source.rewriteLedger === 'rewrite-ledger.json', 'Unexpected rewrite ledger path.');

  const expectedEntries = CHAT_LIB_RUNTIME_ENTRIES.map(({ id, sourcePath }) => ({
    id,
    sourcePath,
  }));
  assert(
    JSON.stringify(manifest.runtimeEntries) === JSON.stringify(expectedEntries),
    'Dependency manifest runtime entries differ from the extractor declaration.',
  );
  assert(
    JSON.stringify(source.entryPoints) === JSON.stringify(expectedEntries),
    'source.json runtime entries differ from the extractor declaration.',
  );
  assert(
    source.sourceModuleCount === manifest.modules.filter((item) => item.kind === 'source').length,
    'source.json source module count is stale.',
  );
  assert(
    source.resourceCount === manifest.modules.filter((item) => item.kind === 'resource').length,
    'source.json resource count is stale.',
  );
}

async function verifyManifestFiles(
  workspaceRoot: string,
  snapshotRoot: string,
  manifest: DependencyManifest,
): Promise<void> {
  const sourcePaths = new Set<string>();
  const snapshotPaths = new Set<string>();
  const entryIds = new Set(CHAT_LIB_RUNTIME_ENTRIES.map((entry) => entry.id));
  for (const item of manifest.modules) {
    assert(!sourcePaths.has(item.sourcePath), `Duplicate source path ${item.sourcePath}.`);
    assert(!snapshotPaths.has(item.snapshotPath), `Duplicate snapshot path ${item.snapshotPath}.`);
    sourcePaths.add(item.sourcePath);
    snapshotPaths.add(item.snapshotPath);
    assert(item.runtimeEntries.length > 0, `${item.sourcePath} has no runtime entry attribution.`);
    for (const entry of item.runtimeEntries) {
      assert(entryIds.has(entry), `${item.sourcePath} has unknown runtime entry ${entry}.`);
    }
    for (const part of FORBIDDEN_REFERENCE_PATH_PARTS) {
      assert(
        !item.sourcePath.includes(part),
        `${item.sourcePath} crosses excluded auth/panel/UI source boundary ${part}.`,
      );
    }
    for (const prefix of CHAT_LIB_FORBIDDEN_SNAPSHOT_SOURCE_PREFIXES) {
      assert(
        item.sourcePath !== prefix && !item.sourcePath.startsWith(prefix),
        `${item.sourcePath} crosses forbidden auth/test/UI/network boundary ${prefix}.`,
      );
    }

    const absolute = path.resolve(workspaceRoot, item.snapshotPath);
    assert(
      absolute.startsWith(`${snapshotRoot}${path.sep}`),
      `${item.snapshotPath} escapes the snapshot root.`,
    );
    const content = await readFile(absolute);
    assert(sha256(content) === item.snapshotSha256, `${item.snapshotPath} hash differs from manifest.`);
    if (item.kind === 'source') {
      const text = content.toString('utf8');
      assert(
        text.startsWith(provenanceHeader(item.sourcePath, manifest.commit)),
        `${item.snapshotPath} has missing or stale provenance.`,
      );
    }
  }

  const actualFiles = await listFiles(snapshotRoot);
  const expectedRelativeFiles = new Set(
    manifest.modules.map((item) =>
      item.snapshotPath.slice(`${CHAT_LIB_SNAPSHOT_ROOT}/`.length),
    ),
  );
  for (const auxiliary of ALLOWED_AUXILIARY_FILES) {
    expectedRelativeFiles.add(auxiliary);
  }
  const unaccounted = actualFiles.filter((file) => !expectedRelativeFiles.has(file));
  const missing = [...expectedRelativeFiles].filter((file) => !actualFiles.includes(file));
  assert(unaccounted.length === 0, `Unaccounted snapshot files: ${unaccounted.join(', ')}`);
  assert(missing.length === 0, `Manifest files missing from snapshot: ${missing.join(', ')}`);
}

async function verifyExternalResourceFiles(
  workspaceRoot: string,
  manifest: DependencyManifest,
): Promise<void> {
  const require = createRequire(path.join(workspaceRoot, 'package.json'));
  for (const resource of manifest.externalResources) {
    const packageJsonPath = require.resolve(`${resource.package}/package.json`);
    const packageJson = await readJson(packageJsonPath);
    assert(isRecord(packageJson), `${resource.package}/package.json must be an object.`);
    assert(
      packageJson.version === resource.version,
      `${resource.package} installed version ${String(packageJson.version)} differs from manifest ${resource.version}.`,
    );
    const packageRoot = path.dirname(packageJsonPath);
    for (const resourcePath of resource.resourcePaths) {
      const absolute = path.resolve(packageRoot, resourcePath);
      assert(
        absolute.startsWith(`${packageRoot}${path.sep}`),
        `${resource.package} resource ${resourcePath} escapes its package root.`,
      );
      try {
        assert(
          (await stat(absolute)).isFile(),
          `${resource.package} resource ${resourcePath} is not a file.`,
        );
      } catch (error: unknown) {
        throw new Error(
          `Missing declared external resource ${resource.package}/${resourcePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

function verifyDependencyAccounting(
  manifest: DependencyManifest,
  ledger: RewriteLedger,
): void {
  const modules = new Map(manifest.modules.map((item) => [item.sourcePath, item]));
  const boundaryRules = new Set(CHAT_LIB_BOUNDARY_RULES.map((rule) => rule.id));
  const ledgerRules = new Set(ledger.serviceReplacements.map((rule) => rule.id));
  assert(
    JSON.stringify([...boundaryRules].sort()) === JSON.stringify([...ledgerRules].sort()),
    'Rewrite ledger service replacements differ from extractor boundary rules.',
  );

  const externalKeys = new Set(
    manifest.externalDependencies.flatMap((item) =>
      item.importers.map((importer) => `${importer}\0${item.specifier}`),
    ),
  );
  const boundaryKeys = new Set(
    manifest.boundaryDependencies.flatMap((item) =>
      item.importers.map(
        (importer) => `${importer}\0${item.boundaryId}\0${item.target}`,
      ),
    ),
  );
  const expectedDynamicAudits = CHAT_LIB_DYNAMIC_RESOURCE_AUDITS
    .filter((audit) => modules.has(audit.sourcePath))
    .map((audit) => ({
      sourcePath: audit.sourcePath,
      markers: audit.markers,
      resolution: audit.resolution,
    }));
  const actualDynamicAudits = manifest.dynamicResourceAudits.map((audit) => ({
    sourcePath: audit.sourcePath,
    markers: audit.markers,
    resolution: audit.resolution,
  }));
  assert(
    JSON.stringify(actualDynamicAudits) === JSON.stringify(expectedDynamicAudits),
    'Dynamic resource audit manifest is missing or stale.',
  );
  for (const audit of manifest.dynamicResourceAudits) {
    assert(audit.runtimeEntries.length > 0, `${audit.sourcePath} dynamic audit is unattributed.`);
  }
  const expectedExternalResources = CHAT_LIB_EXTERNAL_RESOURCES
    .filter((resource) => modules.has(resource.loadedBy))
    .map((resource) => ({
      loadedBy: resource.loadedBy,
      package: resource.packageName,
      version: resource.expectedVersion,
      resourcePaths: resource.resourcePaths,
      reason: resource.reason,
    }));
  const actualExternalResources = manifest.externalResources.map((resource) => ({
    loadedBy: resource.loadedBy,
    package: resource.package,
    version: resource.version,
    resourcePaths: resource.resourcePaths,
    reason: resource.reason,
  }));
  assert(
    JSON.stringify(actualExternalResources) === JSON.stringify(expectedExternalResources),
    'External resource manifest is missing or stale.',
  );
  for (const resource of manifest.externalResources) {
    assert(resource.runtimeEntries.length > 0, `${resource.loadedBy} external resource is unattributed.`);
  }

  for (const module of manifest.modules) {
    for (const dependency of module.dependencies) {
      if (dependency.kind === 'source' || dependency.kind === 'resource') {
        assert(Boolean(dependency.target), `${module.sourcePath} has a targetless internal dependency.`);
        assert(
          dependency.target !== undefined && modules.has(dependency.target),
          `${module.sourcePath} depends on missing manifest target ${dependency.target ?? '<none>'}.`,
        );
      } else if (dependency.kind === 'boundary') {
        assert(Boolean(dependency.boundaryId), `${module.sourcePath} has a boundary without an id.`);
        assert(
          dependency.boundaryId !== undefined && boundaryRules.has(dependency.boundaryId),
          `${module.sourcePath} uses unknown boundary ${dependency.boundaryId ?? '<none>'}.`,
        );
        assert(
          dependency.boundaryId !== undefined &&
            dependency.target !== undefined &&
            boundaryKeys.has(`${module.sourcePath}\0${dependency.boundaryId}\0${dependency.target}`),
          `${module.sourcePath} boundary edge is missing from the aggregate manifest.`,
        );
      } else {
        assert(
          externalKeys.has(`${module.sourcePath}\0${dependency.specifier}`),
          `${module.sourcePath} external ${dependency.specifier} is not accounted for.`,
        );
      }
    }
  }
}

async function collectProductionRuntimeClosure(
  workspaceRoot: string,
): Promise<Set<string>> {
  const closure = new Set<string>();
  const queued = [...PRODUCTION_ENTRY_POINTS];
  while (queued.length > 0) {
    const relativeFile = queued.pop();
    if (!relativeFile || closure.has(relativeFile)) {
      continue;
    }
    closure.add(relativeFile);
    if (!/\.(?:ts|tsx)$/.test(relativeFile)) {
      continue;
    }
    const text = await readFile(path.resolve(workspaceRoot, relativeFile), 'utf8');
    const imports = ts.preProcessFile(text, true, true).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith('.')) {
        continue;
      }
      const candidates = resolveRelativeImportCandidates(relativeFile, imported.fileName);
      const resolved = await firstExistingFile(workspaceRoot, candidates);
      if (!resolved) {
        throw new Error(
          `Unresolved runtime import ${imported.fileName} from ${relativeFile}.`,
        );
      }
      if (resolved === 'src' || resolved.startsWith('src/')) {
        queued.push(resolved);
      }
    }
  }
  return closure;
}

function verifyRuntimeLedger(
  runtimeClosure: ReadonlySet<string>,
  ledger: RewriteLedger,
): void {
  const recorded = new Set(ledger.runtimeFiles);
  const unrecorded = [...runtimeClosure].filter((file) => !recorded.has(file));
  const unused = [...recorded].filter((file) => !runtimeClosure.has(file));
  assert(unrecorded.length === 0, `Runtime files missing from rewrite ledger: ${unrecorded.join(', ')}`);
  assert(unused.length === 0, `Rewrite ledger runtime files are unused: ${unused.join(', ')}`);
}

async function verifyRuntimeSources(
  workspaceRoot: string,
  runtimeClosure: ReadonlySet<string>,
  manifest: DependencyManifest,
  ledger: RewriteLedger,
): Promise<void> {
  const manifestPaths = new Set(manifest.modules.map((item) => item.snapshotPath));
  for (const runtimeFile of runtimeClosure) {
    if (runtimeFile.startsWith(`${CHAT_LIB_SNAPSHOT_ROOT}/`)) {
      assert(manifestPaths.has(runtimeFile), `${runtimeFile} is absent from dependency manifest.`);
    }
    const text = await readFile(path.resolve(workspaceRoot, runtimeFile), 'utf8');
    for (const pattern of ledger.forbiddenPatterns) {
      assert(!text.includes(pattern), `${runtimeFile} contains forbidden pattern ${pattern}.`);
    }
  }
}

async function verifyAdapterSources(
  workspaceRoot: string,
  productionClosure: ReadonlySet<string>,
  adapters: readonly HostAdapterModule[],
  ledger: RewriteLedger,
): Promise<void> {
  const recorded = new Set(ledger.adapterFiles);
  const expectedAdapters = [...productionClosure]
    .filter(
      (file) =>
        file === 'src/completion/manager.ts' ||
        file === 'src/completion/change-hint.ts' ||
        (file.startsWith('src/completion/copilot/') && file.endsWith('.ts')),
    )
    .sort();
  const missingAdapters = expectedAdapters.filter((file) => !recorded.has(file));
  const unusedAdapters = [...recorded].filter(
    (file) => !expectedAdapters.includes(file),
  );
  assert(
    missingAdapters.length === 0,
    `Production Copilot adapters missing from porting manifest: ${missingAdapters.join(', ')}`,
  );
  assert(
    unusedAdapters.length === 0,
    `Porting manifest adapters are outside the production Copilot adapter closure: ${unusedAdapters.join(', ')}`,
  );
  for (const adapter of adapters) {
    assert(recorded.has(adapter.runtimeFile), `${adapter.runtimeFile} is absent from adapter ledger.`);
    assert(
      productionClosure.has(adapter.runtimeFile),
      `${adapter.runtimeFile} is not reachable from the production entry points.`,
    );
    const text = await readFile(path.resolve(workspaceRoot, adapter.runtimeFile), 'utf8');
    for (const pattern of ledger.forbiddenPatterns) {
      assert(!text.includes(pattern), `${adapter.runtimeFile} contains forbidden pattern ${pattern}.`);
    }
  }
}

async function verifyDirectSnapshotImportAccounting(
  workspaceRoot: string,
  productionClosure: ReadonlySet<string>,
  adapters: readonly HostAdapterModule[],
): Promise<void> {
  const adapterFiles = new Set(adapters.map((adapter) => adapter.runtimeFile));
  for (const importer of productionClosure) {
    if (
      importer.startsWith('src/chat-lib/') ||
      !/\.(?:ts|tsx)$/.test(importer)
    ) {
      continue;
    }
    const text = await readFile(path.resolve(workspaceRoot, importer), 'utf8');
    const imports = ts.preProcessFile(text, true, true).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith('.')) continue;
      const resolved = await firstExistingFile(
        workspaceRoot,
        resolveRelativeImportCandidates(importer, imported.fileName),
      );
      if (!resolved?.startsWith(`${CHAT_LIB_SNAPSHOT_ROOT}/`)) continue;
      assert(
        adapterFiles.has(importer),
        `${importer} imports compiled upstream source ${resolved} without a host-adapter ledger entry.`,
      );
    }
  }
}

async function verifyProductionRuntimeImports(workspaceRoot: string): Promise<void> {
  await assertImportResolvesTo(
    workspaceRoot,
    'src/completion/copilot/algorithm.ts',
    'src/completion/copilot/runtime.ts',
  );
  await assertImportResolvesTo(
    workspaceRoot,
    'src/completion/copilot/runtime.ts',
    'src/chat-lib/core/joint/index.ts',
  );
  await assertImportResolvesTo(
    workspaceRoot,
    'src/completion/manager.ts',
    'src/completion/change-hint.ts',
  );
}

async function assertImportResolvesTo(
  workspaceRoot: string,
  importer: string,
  expectedTarget: string,
): Promise<void> {
  const text = await readFile(path.resolve(workspaceRoot, importer), 'utf8');
  const imports = ts.preProcessFile(text, true, true).importedFiles;
  for (const imported of imports) {
    if (!imported.fileName.startsWith('.')) {
      continue;
    }
    const resolved = await firstExistingFile(
      workspaceRoot,
      resolveRelativeImportCandidates(importer, imported.fileName),
    );
    if (resolved === expectedTarget) {
      return;
    }
  }
  throw new Error(`${importer} does not import required production target ${expectedTarget}.`);
}

async function runStrictCompiler(workspaceRoot: string): Promise<void> {
  const workspaceRequire = createRequire(path.join(workspaceRoot, 'package.json'));
  const compiler = workspaceRequire.resolve('typescript/bin/tsc');
  await run(
    process.execPath,
    [compiler, '-p', 'tsconfig.chat-lib.json', '--noEmit'],
    workspaceRoot,
  );
}

async function firstExistingFile(
  workspaceRoot: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      if ((await stat(path.resolve(workspaceRoot, candidate))).isFile()) {
        return candidate.replace(/\\/g, '/');
      }
    } catch {
      // Try the next deterministic candidate.
    }
  }
  return undefined;
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        result.push(relative);
      }
    }
  };
  await visit(root, '');
  return result;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

function parseDependencyManifest(value: unknown): DependencyManifest {
  assert(isRecord(value), 'dependency-manifest.json must be an object.');
  assert(typeof value.schemaVersion === 'number', 'Manifest schemaVersion is missing.');
  assert(typeof value.repository === 'string', 'Manifest repository is missing.');
  assert(typeof value.ref === 'string', 'Manifest ref is missing.');
  assert(typeof value.commit === 'string', 'Manifest commit is missing.');
  assert(Array.isArray(value.runtimeEntries), 'Manifest runtimeEntries is missing.');
  assert(Array.isArray(value.modules), 'Manifest modules is missing.');
  assert(Array.isArray(value.externalDependencies), 'Manifest externalDependencies is missing.');
  assert(Array.isArray(value.boundaryDependencies), 'Manifest boundaryDependencies is missing.');
  assert(Array.isArray(value.dynamicResourceAudits), 'Manifest dynamicResourceAudits is missing.');
  assert(Array.isArray(value.externalResources), 'Manifest externalResources is missing.');
  return {
    schemaVersion: value.schemaVersion,
    repository: value.repository,
    ref: value.ref,
    commit: value.commit,
    runtimeEntries: value.runtimeEntries.map((entry, index) =>
      parseRuntimeEntry(entry, `runtimeEntries[${index}]`),
    ),
    modules: value.modules.map((module, index) =>
      parseManifestModule(module, index),
    ),
    externalDependencies: value.externalDependencies.map((dependency, index) =>
      parseAggregatedExternal(dependency, index),
    ),
    boundaryDependencies: value.boundaryDependencies.map((dependency, index) =>
      parseAggregatedBoundary(dependency, index),
    ),
    dynamicResourceAudits: value.dynamicResourceAudits.map((audit, index) =>
      parseDynamicResourceAudit(audit, index),
    ),
    externalResources: value.externalResources.map((resource, index) =>
      parseExternalResource(resource, index),
    ),
  };
}

function parseSourceMetadata(value: unknown): SourceMetadata {
  assert(isRecord(value), 'source.json must be an object.');
  assert(typeof value.schemaVersion === 'number', 'source.json schemaVersion is missing.');
  assert(typeof value.repository === 'string', 'source.json repository is missing.');
  assert(typeof value.ref === 'string', 'source.json ref is missing.');
  assert(typeof value.commit === 'string', 'source.json commit is missing.');
  assert(Array.isArray(value.entryPoints), 'source.json entryPoints is missing.');
  assert(typeof value.sourceModuleCount === 'number', 'sourceModuleCount is missing.');
  assert(typeof value.resourceCount === 'number', 'resourceCount is missing.');
  assert(typeof value.manifest === 'string', 'source.json manifest is missing.');
  assert(typeof value.rewriteLedger === 'string', 'source.json rewriteLedger is missing.');
  return {
    schemaVersion: value.schemaVersion,
    repository: value.repository,
    ref: value.ref,
    commit: value.commit,
    entryPoints: value.entryPoints.map((entry, index) =>
      parseRuntimeEntry(entry, `source.entryPoints[${index}]`),
    ),
    sourceModuleCount: value.sourceModuleCount,
    resourceCount: value.resourceCount,
    manifest: value.manifest,
    rewriteLedger: value.rewriteLedger,
  };
}

function parseRewriteLedger(value: unknown): RewriteLedger {
  assert(isRecord(value), 'rewrite-ledger.json must be an object.');
  assert(typeof value.schemaVersion === 'number', 'Rewrite ledger schemaVersion is missing.');
  assert(typeof value.repository === 'string', 'Rewrite ledger repository is missing.');
  assert(typeof value.ref === 'string', 'Rewrite ledger ref is missing.');
  assert(typeof value.commit === 'string', 'Rewrite ledger commit is missing.');
  assert(Array.isArray(value.serviceReplacements), 'serviceReplacements is missing.');
  assert(typeof value.portingManifest === 'string', 'portingManifest is missing.');
  assert(Array.isArray(value.behaviorPatches), 'behaviorPatches is missing.');
  assert(Array.isArray(value.hostAdapters), 'hostAdapters is missing.');
  assert(Array.isArray(value.adapterFiles), 'adapterFiles is missing.');
  assert(Array.isArray(value.runtimeFiles), 'runtimeFiles is missing.');
  assert(Array.isArray(value.forbiddenPatterns), 'forbiddenPatterns is missing.');
  return {
    schemaVersion: value.schemaVersion,
    repository: value.repository,
    ref: value.ref,
    commit: value.commit,
    portingManifest: value.portingManifest,
    behaviorPatches: value.behaviorPatches.map((module, index) =>
      parsePortedRuntimeModule(module, `behaviorPatches[${index}]`),
    ),
    hostAdapters: value.hostAdapters.map((adapter, index) =>
      parseHostAdapterModule(adapter, `hostAdapters[${index}]`),
    ),
    adapterFiles: parseStringArray(value.adapterFiles, 'adapterFiles'),
    serviceReplacements: value.serviceReplacements.map((replacement, index) => {
      assert(isRecord(replacement), `serviceReplacements[${index}] must be an object.`);
      assert(typeof replacement.id === 'string', `serviceReplacements[${index}].id is missing.`);
      return {
        id: replacement.id,
        upstreamPaths: parseStringArray(
          replacement.upstreamPaths,
          `serviceReplacements[${index}].upstreamPaths`,
        ),
      };
    }),
    runtimeFiles: parseStringArray(value.runtimeFiles, 'runtimeFiles'),
    forbiddenPatterns: parseStringArray(value.forbiddenPatterns, 'forbiddenPatterns'),
  };
}

function parseBehaviorMatrixUpstream(value: unknown): UpstreamIdentity {
  assert(isRecord(value), 'behavior-matrix.json must be an object.');
  assert(isRecord(value.upstream), 'Behavior matrix upstream metadata is missing.');
  assert(
    typeof value.upstream.repository === 'string',
    'Behavior matrix repository is missing.',
  );
  assert(typeof value.upstream.ref === 'string', 'Behavior matrix ref is missing.');
  assert(
    typeof value.upstream.commit === 'string',
    'Behavior matrix commit is missing.',
  );
  return {
    repository: value.upstream.repository,
    ref: value.upstream.ref,
    commit: value.upstream.commit,
  };
}

function parsePortingManifest(value: unknown): PortingManifest {
  assert(isRecord(value), 'porting-manifest.json must be an object.');
  assert(typeof value.schemaVersion === 'number', 'Porting manifest schemaVersion is missing.');
  assert(typeof value.upstreamCommit === 'string', 'Porting manifest upstreamCommit is missing.');
  assert(Array.isArray(value.runtimeModules), 'Porting manifest runtimeModules is missing.');
  assert(Array.isArray(value.adapterModules), 'Porting manifest adapterModules is missing.');
  return {
    schemaVersion: value.schemaVersion,
    upstreamCommit: value.upstreamCommit,
    runtimeModules: value.runtimeModules.map((module, index) =>
      parsePortedRuntimeModule(module, `runtimeModules[${index}]`),
    ),
    adapterModules: value.adapterModules.map((adapter, index) =>
      parseHostAdapterModule(adapter, `adapterModules[${index}]`),
    ),
    compiledUpstreamSources: parseStringArray(
      value.compiledUpstreamSources,
      'compiledUpstreamSources',
    ),
  };
}

function parseHostAdapterModule(
  value: unknown,
  field: string,
): HostAdapterModule {
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.runtimeFile === 'string', `${field}.runtimeFile is missing.`);
  assert(typeof value.adaptation === 'string', `${field}.adaptation is missing.`);
  return {
    runtimeFile: value.runtimeFile,
    upstreamSources: parseStringArray(value.upstreamSources, `${field}.upstreamSources`),
    replaces: parseStringArray(value.replaces, `${field}.replaces`),
    adaptation: value.adaptation,
  };
}

function parsePortedRuntimeModule(
  value: unknown,
  field: string,
): PortedRuntimeModule {
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.runtimeFile === 'string', `${field}.runtimeFile is missing.`);
  assert(typeof value.status === 'string', `${field}.status is missing.`);
  assert(typeof value.adaptation === 'string', `${field}.adaptation is missing.`);
  return {
    runtimeFile: value.runtimeFile,
    upstreamSources: parseStringArray(value.upstreamSources, `${field}.upstreamSources`),
    status: value.status,
    adaptation: value.adaptation,
  };
}

function parseRuntimeEntry(
  value: unknown,
  field: string,
): { id: string; sourcePath: string } {
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.id === 'string', `${field}.id is missing.`);
  assert(typeof value.sourcePath === 'string', `${field}.sourcePath is missing.`);
  return { id: value.id, sourcePath: value.sourcePath };
}

function parseManifestModule(value: unknown, index: number): ManifestModule {
  const field = `modules[${index}]`;
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.sourcePath === 'string', `${field}.sourcePath is missing.`);
  assert(typeof value.snapshotPath === 'string', `${field}.snapshotPath is missing.`);
  assert(value.kind === 'source' || value.kind === 'resource', `${field}.kind is invalid.`);
  assert(typeof value.sourceSha256 === 'string', `${field}.sourceSha256 is missing.`);
  assert(typeof value.snapshotSha256 === 'string', `${field}.snapshotSha256 is missing.`);
  assert(Array.isArray(value.dependencies), `${field}.dependencies is missing.`);
  return {
    sourcePath: value.sourcePath,
    snapshotPath: value.snapshotPath,
    kind: value.kind,
    runtimeEntries: parseStringArray(value.runtimeEntries, `${field}.runtimeEntries`),
    sourceSha256: value.sourceSha256,
    snapshotSha256: value.snapshotSha256,
    importedBy: parseStringArray(value.importedBy, `${field}.importedBy`),
    dependencies: value.dependencies.map((dependency, dependencyIndex) =>
      parseManifestDependency(dependency, `${field}.dependencies[${dependencyIndex}]`),
    ),
  };
}

function parseManifestDependency(
  value: unknown,
  field: string,
): ManifestDependency {
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.specifier === 'string', `${field}.specifier is missing.`);
  assert(
    value.kind === 'source' ||
      value.kind === 'resource' ||
      value.kind === 'boundary' ||
      value.kind === 'external',
    `${field}.kind is invalid.`,
  );
  assert(value.target === undefined || typeof value.target === 'string', `${field}.target is invalid.`);
  assert(
    value.boundaryId === undefined || typeof value.boundaryId === 'string',
    `${field}.boundaryId is invalid.`,
  );
  return {
    specifier: value.specifier,
    kind: value.kind,
    target: value.target,
    boundaryId: value.boundaryId,
  };
}

function parseAggregatedExternal(
  value: unknown,
  index: number,
): DependencyManifest['externalDependencies'][number] {
  const field = `externalDependencies[${index}]`;
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.specifier === 'string', `${field}.specifier is missing.`);
  return {
    specifier: value.specifier,
    importers: parseStringArray(value.importers, `${field}.importers`),
    runtimeEntries: parseStringArray(value.runtimeEntries, `${field}.runtimeEntries`),
  };
}

function parseAggregatedBoundary(
  value: unknown,
  index: number,
): DependencyManifest['boundaryDependencies'][number] {
  const field = `boundaryDependencies[${index}]`;
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.boundaryId === 'string', `${field}.boundaryId is missing.`);
  assert(typeof value.target === 'string', `${field}.target is missing.`);
  return {
    boundaryId: value.boundaryId,
    target: value.target,
    importers: parseStringArray(value.importers, `${field}.importers`),
    runtimeEntries: parseStringArray(value.runtimeEntries, `${field}.runtimeEntries`),
  };
}

function parseDynamicResourceAudit(
  value: unknown,
  index: number,
): DependencyManifest['dynamicResourceAudits'][number] {
  const field = `dynamicResourceAudits[${index}]`;
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.sourcePath === 'string', `${field}.sourcePath is missing.`);
  assert(typeof value.resolution === 'string', `${field}.resolution is missing.`);
  return {
    sourcePath: value.sourcePath,
    markers: parseStringArray(value.markers, `${field}.markers`),
    resolution: value.resolution,
    runtimeEntries: parseStringArray(value.runtimeEntries, `${field}.runtimeEntries`),
  };
}

function parseExternalResource(
  value: unknown,
  index: number,
): DependencyManifest['externalResources'][number] {
  const field = `externalResources[${index}]`;
  assert(isRecord(value), `${field} must be an object.`);
  assert(typeof value.loadedBy === 'string', `${field}.loadedBy is missing.`);
  assert(typeof value.package === 'string', `${field}.package is missing.`);
  assert(typeof value.version === 'string', `${field}.version is missing.`);
  assert(typeof value.reason === 'string', `${field}.reason is missing.`);
  return {
    loadedBy: value.loadedBy,
    package: value.package,
    version: value.version,
    resourcePaths: parseStringArray(value.resourcePaths, `${field}.resourcePaths`),
    reason: value.reason,
    runtimeEntries: parseStringArray(value.runtimeEntries, `${field}.runtimeEntries`),
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  assert(Array.isArray(value), `${field} must be an array.`);
  assert(
    value.every((item): item is string => typeof item === 'string'),
    `${field} must contain only strings.`,
  );
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code ?? 'signal'}.`));
      }
    });
  });
}
