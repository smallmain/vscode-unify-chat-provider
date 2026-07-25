import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runChatLibUpdateWorkflow,
  type ChatLibUpdatePhase,
  type ChatLibUpdatePhaseContext,
} from '../../scripts/chat-lib-update-workflow';

const PHASES: readonly ChatLibUpdatePhase[] = [
  'extract',
  'verify',
  'build-runtime',
  'test-evidence',
];

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('chat-lib update workflow', () => {
  it('runs every phase in order and publishes all generated artifacts', async () => {
    const workspaceRoot = await createWorkspace();
    const observedPhases: ChatLibUpdatePhase[] = [];
    let candidateRoot = '';

    await runChatLibUpdateWorkflow({
      workspaceRoot,
      sourceRoot: workspaceRoot,
      ref: 'fixed-commit',
      check: false,
      temporaryParent: path.join(workspaceRoot, 'temporary'),
      phaseRunner: async (context) => {
        observedPhases.push(context.phase);
        candidateRoot = context.candidateRoot;
        await runFakePhase(context, 'new');
      },
    });

    expect(observedPhases).toEqual(PHASES);
    expect(await readArtifacts(workspaceRoot)).toEqual({
      source: 'new-source\n',
      snapshot: 'new-snapshot\n',
      runtime: 'new-runtime\n',
    });
    await expect(access(candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  for (const failedPhase of PHASES) {
    it(`leaves repository outputs untouched when ${failedPhase} fails`, async () => {
      const workspaceRoot = await createWorkspace();
      const before = await readArtifacts(workspaceRoot);

      await expect(
        runChatLibUpdateWorkflow({
          workspaceRoot,
          sourceRoot: workspaceRoot,
          ref: 'fixed-commit',
          check: false,
          temporaryParent: path.join(workspaceRoot, 'temporary'),
          phaseRunner: async (context) => {
            await runFakePhase(context, 'new');
            if (context.phase === failedPhase) {
              throw new Error(`injected ${failedPhase} failure`);
            }
          },
        }),
      ).rejects.toThrow(`injected ${failedPhase} failure`);

      expect(await readArtifacts(workspaceRoot)).toEqual(before);
    });
  }

  it('rolls back previously installed artifacts when publication fails', async () => {
    const workspaceRoot = await createWorkspace();
    const before = await readArtifacts(workspaceRoot);

    await expect(
      runChatLibUpdateWorkflow({
        workspaceRoot,
        sourceRoot: workspaceRoot,
        ref: 'fixed-commit',
        check: false,
        temporaryParent: path.join(workspaceRoot, 'temporary'),
        phaseRunner: (context) => runFakePhase(context, 'new'),
        beforeInstallArtifact: ({ index }) => {
          if (index === 1) {
            throw new Error('injected publication failure');
          }
        },
      }),
    ).rejects.toThrow('injected publication failure');

    expect(await readArtifacts(workspaceRoot)).toEqual(before);
    expect(await transactionFiles(workspaceRoot)).toEqual([]);
  });

  it('does not overwrite repository outputs changed by another process', async () => {
    const workspaceRoot = await createWorkspace();

    await expect(
      runChatLibUpdateWorkflow({
        workspaceRoot,
        sourceRoot: workspaceRoot,
        ref: 'fixed-commit',
        check: false,
        temporaryParent: path.join(workspaceRoot, 'temporary'),
        phaseRunner: async (context) => {
          await runFakePhase(context, 'new');
          if (context.phase === 'verify') {
            await writeSnapshot(workspaceRoot, 'concurrent');
          }
        },
      }),
    ).rejects.toThrow('changed while the update was running');

    expect(await readArtifacts(workspaceRoot)).toEqual({
      source: 'concurrent-source\n',
      snapshot: 'concurrent-snapshot\n',
      runtime: 'old-runtime\n',
    });
    expect(await transactionFiles(workspaceRoot)).toEqual([]);
  });

  it('check mode runs every phase without publishing runtime output', async () => {
    const workspaceRoot = await createWorkspace();
    const before = await readArtifacts(workspaceRoot);
    const observedPhases: ChatLibUpdatePhase[] = [];

    await runChatLibUpdateWorkflow({
      workspaceRoot,
      sourceRoot: workspaceRoot,
      ref: 'fixed-commit',
      check: true,
      temporaryParent: path.join(workspaceRoot, 'temporary'),
      phaseRunner: async (context) => {
        observedPhases.push(context.phase);
        if (context.phase === 'build-runtime') {
          await writeRuntime(context.candidateRoot, 'candidate');
        }
      },
    });

    expect(observedPhases).toEqual(PHASES);
    expect(await readArtifacts(workspaceRoot)).toEqual(before);
  });

  it('check mode reports stale generated outputs without publishing them', async () => {
    const workspaceRoot = await createWorkspace();
    const before = await readArtifacts(workspaceRoot);

    await expect(
      runChatLibUpdateWorkflow({
        workspaceRoot,
        sourceRoot: workspaceRoot,
        ref: 'fixed-commit',
        check: true,
        temporaryParent: path.join(workspaceRoot, 'temporary'),
        phaseRunner: (context) => runFakePhase(context, 'new'),
      }),
    ).rejects.toThrow('Generated chat-lib outputs are stale');

    expect(await readArtifacts(workspaceRoot)).toEqual(before);
  });
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), 'ucp-chat-lib-update-test-'),
  );
  temporaryRoots.push(workspaceRoot);
  await Promise.all([
    mkdir(path.join(workspaceRoot, 'src/chat-lib/upstream'), {
      recursive: true,
    }),
    mkdir(path.join(workspaceRoot, 'scripts'), { recursive: true }),
    mkdir(path.join(workspaceRoot, 'test/parity'), {
      recursive: true,
    }),
    mkdir(path.join(workspaceRoot, 'node_modules'), { recursive: true }),
    mkdir(path.join(workspaceRoot, 'dist'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(workspaceRoot, 'src/chat-lib/upstream/source.json'),
      'old-source\n',
    ),
    writeFile(
      path.join(workspaceRoot, 'src/chat-lib/upstream/snapshot.ts'),
      'old-snapshot\n',
    ),
    writeFile(path.join(workspaceRoot, 'dist/runtime.cjs'), 'old-runtime\n'),
    writeFile(path.join(workspaceRoot, 'package.json'), '{}\n'),
    writeFile(path.join(workspaceRoot, 'package-lock.json'), '{}\n'),
    writeFile(path.join(workspaceRoot, 'tsconfig.json'), '{}\n'),
    writeFile(path.join(workspaceRoot, 'tsconfig.chat-lib.json'), '{}\n'),
    writeFile(path.join(workspaceRoot, 'vitest.config.ts'), 'export {};\n'),
  ]);
  return workspaceRoot;
}

async function runFakePhase(
  context: ChatLibUpdatePhaseContext,
  version: string,
): Promise<void> {
  switch (context.phase) {
    case 'extract':
      await writeSnapshot(context.candidateRoot, version);
      return;
    case 'build-runtime':
      await writeRuntime(context.candidateRoot, version);
      return;
    case 'verify':
    case 'test-evidence':
      return;
  }
}

async function writeSnapshot(root: string, version: string): Promise<void> {
  const snapshotRoot = path.join(root, 'src/chat-lib/upstream');
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(snapshotRoot, 'source.json'), `${version}-source\n`),
    writeFile(path.join(snapshotRoot, 'snapshot.ts'), `${version}-snapshot\n`),
  ]);
}

async function writeRuntime(root: string, version: string): Promise<void> {
  const distRoot = path.join(root, 'dist');
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  await writeFile(path.join(distRoot, 'runtime.cjs'), `${version}-runtime\n`);
}

async function readArtifacts(root: string): Promise<{
  source: string;
  snapshot: string;
  runtime: string;
}> {
  const [source, snapshot, runtime] = await Promise.all([
    readFile(path.join(root, 'src/chat-lib/upstream/source.json'), 'utf8'),
    readFile(path.join(root, 'src/chat-lib/upstream/snapshot.ts'), 'utf8'),
    readFile(path.join(root, 'dist/runtime.cjs'), 'utf8'),
  ]);
  return { source, snapshot, runtime };
}

async function transactionFiles(root: string): Promise<string[]> {
  const parents = [
    path.join(root, 'src/chat-lib'),
    root,
  ];
  const result: string[] = [];
  for (const parent of parents) {
    const entries = await readdir(parent);
    result.push(
      ...entries.filter(
        (entry) => entry.includes('.ucp-stage-') || entry.includes('.ucp-backup-'),
      ),
    );
  }
  return result.sort();
}
