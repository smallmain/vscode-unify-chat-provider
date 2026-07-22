import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export type ChatLibUpdatePhase =
  | 'extract'
  | 'verify'
  | 'build-runtime'
  | 'test-evidence';

export interface ChatLibUpdatePhaseContext {
  phase: ChatLibUpdatePhase;
  candidateRoot: string;
  sourceRoot: string;
  ref: string;
}

export type ChatLibUpdatePhaseRunner = (
  context: ChatLibUpdatePhaseContext,
) => Promise<void>;

export interface PublishArtifactContext {
  index: number;
  relativePath: string;
}

export interface RunChatLibUpdateWorkflowOptions {
  workspaceRoot: string;
  sourceRoot: string;
  ref: string;
  check: boolean;
  temporaryParent?: string;
  phaseRunner?: ChatLibUpdatePhaseRunner;
  beforeInstallArtifact?: (
    context: PublishArtifactContext,
  ) => void | Promise<void>;
}

interface ArtifactDefinition {
  relativePath: string;
  compareInCheck: boolean;
}

interface PreparedArtifact extends ArtifactDefinition {
  candidatePath: string;
  targetPath: string;
  stagePath: string;
  backupPath: string;
  backupCreated: boolean;
  installed: boolean;
}

const CANDIDATE_DIRECTORIES = ['src', 'scripts', 'test'] as const;
const CANDIDATE_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.chat-lib.json',
  'vitest.config.ts',
] as const;

const UPDATE_PHASES: readonly ChatLibUpdatePhase[] = [
  'extract',
  'verify',
  'build-runtime',
  'test-evidence',
];

const GENERATED_ARTIFACTS: readonly ArtifactDefinition[] = [
  {
    relativePath: 'src/chat-lib/upstream',
    compareInCheck: true,
  },
  {
    relativePath: 'dist',
    compareInCheck: false,
  },
];

const PHASE_LABELS: Readonly<Record<ChatLibUpdatePhase, string>> = {
  extract: 'Extracting the pinned upstream snapshot',
  verify: 'Verifying snapshot, provenance, boundaries, and strict types',
  'build-runtime': 'Building and smoke-testing chat-lib runtime bundles',
  'test-evidence': 'Testing completion-effect parity',
};

export async function runChatLibUpdateWorkflow(
  options: RunChatLibUpdateWorkflowOptions,
): Promise<void> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const sourceRoot = path.resolve(options.sourceRoot);
  const baselineDigests = options.check
    ? undefined
    : await captureArtifactDigests(workspaceRoot);
  const temporaryParent = path.resolve(options.temporaryParent ?? tmpdir());
  await mkdir(temporaryParent, { recursive: true });
  const candidateRoot = await mkdtemp(
    path.join(temporaryParent, 'ucp-chat-lib-workspace-'),
  );

  try {
    await copyCandidateWorkspace(workspaceRoot, candidateRoot);
    const phaseRunner =
      options.phaseRunner ?? createDefaultPhaseRunner(workspaceRoot);
    for (const phase of UPDATE_PHASES) {
      console.log(`[chat-lib] ${PHASE_LABELS[phase]}...`);
      await phaseRunner({
        phase,
        candidateRoot,
        sourceRoot,
        ref: options.ref,
      });
    }

    if (options.check) {
      await assertGeneratedArtifactsCurrent(workspaceRoot, candidateRoot);
      console.log('[chat-lib] Runtime snapshot output is current.');
      return;
    }

    if (baselineDigests) {
      await assertArtifactsUnchanged(workspaceRoot, baselineDigests);
    }
    await publishGeneratedArtifacts(workspaceRoot, candidateRoot, {
      beforeInstallArtifact: options.beforeInstallArtifact,
    });
    console.log('[chat-lib] Updated runtime snapshot and bundles.');
  } finally {
    await rm(candidateRoot, { recursive: true, force: true });
  }
}

async function captureArtifactDigests(
  workspaceRoot: string,
): Promise<ReadonlyMap<string, string | null>> {
  const digests = new Map<string, string | null>();
  for (const artifact of GENERATED_ARTIFACTS) {
    digests.set(
      artifact.relativePath,
      await digestPath(path.join(workspaceRoot, artifact.relativePath)),
    );
  }
  return digests;
}

async function assertArtifactsUnchanged(
  workspaceRoot: string,
  baselineDigests: ReadonlyMap<string, string | null>,
): Promise<void> {
  const changed: string[] = [];
  for (const artifact of GENERATED_ARTIFACTS) {
    const current = await digestPath(
      path.join(workspaceRoot, artifact.relativePath),
    );
    if (current !== baselineDigests.get(artifact.relativePath)) {
      changed.push(artifact.relativePath);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `Generated chat-lib outputs changed while the update was running: ${changed.join(', ')}. ` +
        'Review those concurrent changes and run the update again.',
    );
  }
}

async function copyCandidateWorkspace(
  workspaceRoot: string,
  candidateRoot: string,
): Promise<void> {
  for (const directory of CANDIDATE_DIRECTORIES) {
    await cp(
      path.join(workspaceRoot, directory),
      path.join(candidateRoot, directory),
      {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      },
    );
  }
  for (const file of CANDIDATE_FILES) {
    await copyFile(path.join(workspaceRoot, file), path.join(candidateRoot, file));
  }

  const nodeModules = path.join(workspaceRoot, 'node_modules');
  const nodeModulesStat = await lstat(nodeModules);
  if (!nodeModulesStat.isDirectory()) {
    throw new Error(`Expected a node_modules directory at ${nodeModules}.`);
  }
  await symlink(
    nodeModules,
    path.join(candidateRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function createDefaultPhaseRunner(
  workspaceRoot: string,
): ChatLibUpdatePhaseRunner {
  const workspaceRequire = createRequire(path.join(workspaceRoot, 'package.json'));
  const tsxCli = workspaceRequire.resolve('tsx/cli');
  const vitestPackage = workspaceRequire.resolve('vitest/package.json');
  const vitestCli = path.join(path.dirname(vitestPackage), 'vitest.mjs');

  return async (context): Promise<void> => {
    switch (context.phase) {
      case 'extract':
        await runCommand(
          process.execPath,
          [
            tsxCli,
            path.join(context.candidateRoot, 'scripts/extract-chat-lib.ts'),
            '--source',
            context.sourceRoot,
            '--ref',
            context.ref,
          ],
          context.candidateRoot,
        );
        return;
      case 'verify':
        await runCommand(
          process.execPath,
          [
            tsxCli,
            path.join(context.candidateRoot, 'scripts/verify-chat-lib.ts'),
          ],
          context.candidateRoot,
        );
        return;
      case 'build-runtime':
        await runCommand(
          process.execPath,
          [
            tsxCli,
            path.join(
              context.candidateRoot,
              'scripts/copy-chat-lib-resources.ts',
            ),
          ],
          context.candidateRoot,
        );
        return;
      case 'test-evidence':
        await runCommand(
          process.execPath,
          [
            vitestCli,
            'run',
            'test/parity',
          ],
          context.candidateRoot,
        );
        return;
    }
  };
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${path.basename(command)} ${args.join(' ')} failed (${String(code)}).`,
          ),
        );
      }
    });
  });
}

async function assertGeneratedArtifactsCurrent(
  workspaceRoot: string,
  candidateRoot: string,
): Promise<void> {
  const stale: string[] = [];
  for (const artifact of GENERATED_ARTIFACTS) {
    if (!artifact.compareInCheck) continue;
    const currentDigest = await digestPath(
      path.join(workspaceRoot, artifact.relativePath),
    );
    const candidateDigest = await digestPath(
      path.join(candidateRoot, artifact.relativePath),
    );
    if (currentDigest !== candidateDigest) {
      stale.push(artifact.relativePath);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Generated chat-lib outputs are stale: ${stale.join(', ')}. ` +
        'Run npm run extract:chat-lib without --check to update them.',
    );
  }
}

async function publishGeneratedArtifacts(
  workspaceRoot: string,
  candidateRoot: string,
  options: {
    beforeInstallArtifact?: (
      context: PublishArtifactContext,
    ) => void | Promise<void>;
  },
): Promise<void> {
  const transactionId = randomUUID();
  const prepared: PreparedArtifact[] = [];

  try {
    for (const artifact of GENERATED_ARTIFACTS) {
      const candidatePath = path.join(candidateRoot, artifact.relativePath);
      const targetPath = path.join(workspaceRoot, artifact.relativePath);
      const parent = path.dirname(targetPath);
      const name = path.basename(targetPath);
      await mkdir(parent, { recursive: true });
      const stagePath = path.join(parent, `.${name}.ucp-stage-${transactionId}`);
      const backupPath = path.join(parent, `.${name}.ucp-backup-${transactionId}`);
      const preparedArtifact: PreparedArtifact = {
        ...artifact,
        candidatePath,
        targetPath,
        stagePath,
        backupPath,
        backupCreated: false,
        installed: false,
      };
      prepared.push(preparedArtifact);
      await copyArtifact(candidatePath, stagePath);
    }

    for (let index = 0; index < prepared.length; index += 1) {
      const artifact = prepared[index];
      if (!artifact) continue;
      if (await pathExists(artifact.targetPath)) {
        await rename(artifact.targetPath, artifact.backupPath);
        artifact.backupCreated = true;
      }
      await options.beforeInstallArtifact?.({
        index,
        relativePath: artifact.relativePath,
      });
      await rename(artifact.stagePath, artifact.targetPath);
      artifact.installed = true;
    }
  } catch (error) {
    const rollbackErrors = await rollbackArtifacts(prepared);
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Chat-lib publication failed (${formatError(error)}) and rollback also failed: ` +
          rollbackErrors.join('; '),
      );
    }
    throw error;
  }

  await cleanupPreparedArtifacts(prepared);
}

async function copyArtifact(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isDirectory()) {
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported generated artifact: ${source}`);
  }
  await copyFile(source, destination);
}

async function rollbackArtifacts(
  prepared: readonly PreparedArtifact[],
): Promise<string[]> {
  const errors: string[] = [];
  for (const artifact of [...prepared].reverse()) {
    try {
      if (artifact.installed) {
        await rm(artifact.targetPath, { recursive: true, force: true });
      }
      if (artifact.backupCreated) {
        await rename(artifact.backupPath, artifact.targetPath);
        artifact.backupCreated = false;
      }
      await rm(artifact.stagePath, { recursive: true, force: true });
    } catch (error) {
      errors.push(`${artifact.relativePath}: ${formatError(error)}`);
    }
  }
  return errors;
}

async function cleanupPreparedArtifacts(
  prepared: readonly PreparedArtifact[],
): Promise<void> {
  for (const artifact of prepared) {
    await rm(artifact.stagePath, { recursive: true, force: true });
    await rm(artifact.backupPath, { recursive: true, force: true });
  }
}

async function digestPath(target: string): Promise<string | null> {
  if (!(await pathExists(target))) return null;
  const hash = createHash('sha256');

  const visit = async (absolutePath: string, relativePath: string): Promise<void> => {
    const item = await lstat(absolutePath);
    if (item.isDirectory()) {
      hash.update(`directory:${relativePath}\0`);
      const entries = await readdir(absolutePath);
      for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
        await visit(path.join(absolutePath, entry), path.posix.join(relativePath, entry));
      }
      return;
    }
    if (item.isFile()) {
      hash.update(`file:${relativePath}\0`);
      hash.update(await readFile(absolutePath));
      hash.update('\0');
      return;
    }
    if (item.isSymbolicLink()) {
      hash.update(`link:${relativePath}:${await readlink(absolutePath)}\0`);
      return;
    }
    throw new Error(`Unsupported artifact entry: ${absolutePath}`);
  };

  await visit(target, '.');
  return hash.digest('hex');
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
