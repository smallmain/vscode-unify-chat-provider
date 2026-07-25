import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { runChatLibUpdateWorkflow } from './chat-lib-update-workflow';

const EXPECTED_REPOSITORY = 'https://github.com/microsoft/vscode.git';

interface UpstreamIdentity {
  repository: string;
  ref: string;
  commit: string;
}

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    ref: { type: 'string' },
    check: { type: 'boolean' },
  },
});

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const matrix = await readUpstreamIdentity(
    path.join(workspaceRoot, 'test/parity/behavior-matrix.json'),
    'behavior matrix',
  );
  if (matrix.repository !== EXPECTED_REPOSITORY) {
    throw new Error(
      `Unsupported behavior matrix repository: ${matrix.repository}.`,
    );
  }

  const ref = values.ref ?? matrix.ref;
  if (ref !== matrix.ref) {
    throw new Error(
      `Requested ref ${ref} differs from behavior matrix ref ${matrix.ref}. ` +
        'Review and update the behavior matrix before extracting a new ref.',
    );
  }

  const portingCommit = await readPortingCommit(
    path.join(workspaceRoot, 'src/chat-lib/porting-manifest.json'),
  );
  if (portingCommit !== matrix.commit) {
    throw new Error(
      `Porting manifest commit ${portingCommit} differs from behavior matrix commit ${matrix.commit}.`,
    );
  }

  let sourceRoot = values.source ?? process.env['VSCODE_UPSTREAM_PATH'];
  let temporaryClone: string | undefined;
  try {
    if (!sourceRoot) {
      temporaryClone = await mkdtemp(path.join(tmpdir(), 'ucp-vscode-'));
      console.log(`[chat-lib] Cloning ${matrix.repository} once for all update phases...`);
      await runCommand(
        'git',
        [
          'clone',
          '--filter=blob:none',
          '--no-checkout',
          matrix.repository,
          temporaryClone,
        ],
        workspaceRoot,
        false,
      );
      sourceRoot = temporaryClone;
    }
    sourceRoot = path.resolve(workspaceRoot, sourceRoot);

    const resolvedCommit = (
      await runCommand(
        'git',
        ['-C', sourceRoot, 'rev-parse', `${ref}^{commit}`],
        workspaceRoot,
        true,
      )
    ).trim();
    if (resolvedCommit !== matrix.commit) {
      throw new Error(
        `Behavior matrix expects ${matrix.commit}, but ${ref} resolves to ${resolvedCommit}.`,
      );
    }

    await runChatLibUpdateWorkflow({
      workspaceRoot,
      sourceRoot,
      ref,
      check: values.check === true,
    });
  } finally {
    if (temporaryClone) {
      await rm(temporaryClone, { recursive: true, force: true });
    }
  }
}

async function readUpstreamIdentity(
  file: string,
  label: string,
): Promise<UpstreamIdentity> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(value) || !isRecord(value['upstream'])) {
    throw new Error(`Invalid ${label}: missing upstream metadata.`);
  }
  const upstream = value['upstream'];
  return {
    repository: requiredString(upstream, 'repository', label),
    ref: requiredString(upstream, 'ref', label),
    commit: requiredString(upstream, 'commit', label),
  };
}

async function readPortingCommit(file: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(value)) {
    throw new Error('Invalid porting manifest.');
  }
  return requiredString(value, 'upstreamCommit', 'porting manifest');
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const item = value[key];
  if (typeof item !== 'string' || item.length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty ${key}.`);
  }
  return item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  capture: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    if (capture && child.stdout && child.stderr) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed (${String(code)}): ${stderr || stdout}`,
          ),
        );
      }
    });
  });
}
