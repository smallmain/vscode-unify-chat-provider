import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type TestRepository = {
  root: string;
  origin: string;
  release: string;
  rival: string;
};

type ToolCall = {
  tool: string;
  args: string[];
};

const releaseScript = resolve(process.cwd(), 'scripts/release.mts');
const realVsce = resolve(process.cwd(), 'node_modules/.bin/vsce');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('release script coordination', () => {
  it.skipIf(process.platform === 'win32')(
    'stops before external publishing when origin/main advances before the atomic push',
    async () => {
      const repository = await createRepository();
      const toolsDirectory = join(repository.root, 'tools');
      const callLog = join(repository.root, 'tool-calls.jsonl');
      await mkdir(toolsDirectory, { recursive: true });
      await installFakeTools(toolsDirectory);

      const result = runRelease(
        repository.release,
        ['--yes', '--version', '1.1.0'],
        {
          PATH: `${toolsDirectory}:${process.env.PATH ?? ''}`,
          REAL_VSCE: realVsce,
          RELEASE_TEST_CALL_LOG: callLog,
          RELEASE_TEST_ADVANCE_REPO: repository.rival,
        },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toContain(
        'failed to push some refs',
      );

      const calls = await readToolCalls(callLog);
      expect(calls.some((call) => call.tool === 'vsce' && call.args[0] === 'show')).toBe(true);
      expect(calls.some((call) => call.tool === 'vsce' && call.args[0] === 'package')).toBe(true);
      expect(calls.some((call) => call.tool === 'vsce' && call.args[0] === 'publish')).toBe(false);
      expect(calls.some((call) => call.tool === 'gh' && call.args[1] === 'create')).toBe(false);
      expect(calls.some((call) => call.tool === 'gh' && call.args[1] === 'upload')).toBe(false);

      expect(
        run('git', ['ls-remote', '--tags', repository.origin, 'v1.1.0'], repository.release).stdout.trim(),
      ).toBe('');
      expect(
        run('git', ['log', '-1', '--format=%s', 'refs/remotes/origin/main'], repository.rival).stdout.trim(),
      ).toBe('rival advance');
    },
    60_000,
  );

  it.skipIf(process.platform === 'win32')(
    'reconciles ambiguous external responses by matching remote VSIX hashes',
    async () => {
      const repository = await createRepository();
      const toolsDirectory = join(repository.root, 'tools');
      const callLog = join(repository.root, 'tool-calls.jsonl');
      const marketplaceState = join(repository.root, 'marketplace.json');
      const githubState = join(repository.root, 'github-release.json');
      await mkdir(toolsDirectory, { recursive: true });
      await installFakeTools(toolsDirectory);

      const result = runRelease(
        repository.release,
        ['--yes', '--version', '1.1.0'],
        {
          ...process.env,
          PATH: `${toolsDirectory}:${process.env.PATH ?? ''}`,
          REAL_VSCE: realVsce,
          RELEASE_TEST_CALL_LOG: callLog,
          RELEASE_TEST_MARKETPLACE_STATE: marketplaceState,
          RELEASE_TEST_GITHUB_STATE: githubState,
          RELEASE_TEST_AMBIGUOUS_RESPONSES: 'true',
          RELEASE_TEST_DELAYED_MARKETPLACE_VISIBILITY: 'true',
        },
      );

      expect(`${result.stderr}\n${result.stdout}`).not.toContain('failed (attempt');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'VS Code Marketplace publication verified: TestPublisher.test-extension@1.1.0.',
      );
      expect(result.stdout).toContain(
        'GitHub Release publication verified: v1.1.0.',
      );
      expect(result.stdout).toContain(
        'Release reconciliation succeeded for v1.1.0',
      );
      expect(result.stdout).toContain(
        'despite an ambiguous create response',
      );
      expect(result.stdout).toContain(
        'despite an ambiguous upload response',
      );
      expect(`${result.stderr}\n${result.stdout}`).toContain(
        'switching to read-only reconciliation',
      );

      const remoteTag = run(
        'git',
        ['ls-remote', repository.origin, 'refs/tags/v1.1.0^{}'],
        repository.release,
      ).stdout.trim();
      expect(remoteTag).not.toBe('');

      const calls = await readToolCalls(callLog);
      expect(calls.some((call) => call.tool === 'vsce' && call.args[0] === 'publish')).toBe(true);
      expect(calls.some((call) => call.tool === 'gh' && call.args[1] === 'create')).toBe(true);
      expect(calls.some((call) => call.tool === 'gh' && call.args[1] === 'upload')).toBe(true);
    },
    60_000,
  );

  it('rejects resume when the tag and package version disagree', async () => {
    const repository = await createRepository();
    runOk('git', ['tag', '-a', 'v1.1.0', '-m', 'v1.1.0'], repository.release);
    runOk('git', ['push', 'origin', 'v1.1.0'], repository.release);
    runOk('git', ['checkout', '--detach', 'v1.1.0'], repository.release);

    const result = runRelease(repository.release, [
      '--yes',
      '--resume-from-tag',
      'v1.1.0',
      '--skip-publish',
      '--skip-github',
    ]);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain(
      'Tag/package version mismatch: v1.1.0 contains package version 1.0.0.',
    );
  });

  it('keeps the repository unchanged during a full dry-run', async () => {
    const repository = await createRepository();
    const before = run('git', ['rev-parse', 'HEAD'], repository.release).stdout.trim();

    const result = runRelease(repository.release, [
      '--yes',
      '--dry-run',
      '--version',
      '1.1.0',
      '--skip-publish',
      '--skip-github',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Dry-run: no repository files modified and no mutating commands executed.',
    );
    expect(run('git', ['rev-parse', 'HEAD'], repository.release).stdout.trim()).toBe(before);
    expect(run('git', ['status', '--porcelain'], repository.release).stdout.trim()).toBe('');
    expect(run('git', ['tag', '--list', 'v1.1.0'], repository.release).stdout.trim()).toBe('');
    const packageJson: unknown = JSON.parse(
      await readFile(join(repository.release, 'package.json'), 'utf8'),
    );
    expect(packageJson).toMatchObject({ version: '1.0.0' });
  });

  it('rejects a full version that does not increase package.json', async () => {
    const repository = await createRepository();
    const result = runRelease(repository.release, [
      '--yes',
      '--dry-run',
      '--version',
      '0.9.0',
      '--skip-publish',
      '--skip-github',
    ]);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain(
      'Full release version must be greater than package.json (1.0.0): 0.9.0',
    );
  });
});

async function createRepository(): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), 'ucp-release-script-'));
  temporaryRoots.push(root);
  const seed = join(root, 'seed');
  const origin = join(root, 'origin.git');
  const release = join(root, 'release');
  const rival = join(root, 'rival');

  runOk('git', ['init', '--initial-branch=main', seed], root);
  configureGit(seed);
  await writeFile(
    join(seed, 'package.json'),
    `${JSON.stringify(
      {
        name: 'test-extension',
        displayName: 'Test Extension',
        description: 'Release coordination fixture.',
        publisher: 'TestPublisher',
        version: '1.0.0',
        engines: { vscode: '^1.80.0' },
        main: './extension.js',
        activationEvents: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(seed, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'test-extension',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'test-extension',
            version: '1.0.0',
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(seed, 'CHANGELOG.md'),
    '# Changelog\n\n## v1.0.0 - 2026-01-01\n\n- Initial.\n',
    'utf8',
  );
  await writeFile(join(seed, 'README.md'), '# Test Extension\n', 'utf8');
  await writeFile(join(seed, 'extension.js'), 'module.exports = {};\n', 'utf8');
  runOk('git', ['add', '.'], seed);
  runOk('git', ['commit', '-m', 'feat: initial release'], seed);
  runOk('git', ['tag', '-a', 'v1.0.0', '-m', 'v1.0.0'], seed);
  runOk('git', ['clone', '--bare', seed, origin], root);
  runOk('git', ['clone', origin, release], root);
  runOk('git', ['clone', origin, rival], root);
  configureGit(release);
  configureGit(rival);
  return { root, origin, release, rival };
}

function configureGit(repository: string): void {
  runOk('git', ['config', 'user.name', 'Release Test'], repository);
  runOk('git', ['config', 'user.email', 'release-test@example.com'], repository);
}

async function installFakeTools(directory: string): Promise<void> {
  const vscePath = join(directory, 'vsce');
  const ghPath = join(directory, 'gh');
  await writeFile(
    vscePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_CALL_LOG, JSON.stringify({ tool: 'vsce', args }) + '\\n');
if (args[0] === 'show') {
  const state = process.env.RELEASE_TEST_MARKETPLACE_STATE;
  const pendingState = state ? state + '.pending' : '';
  if (pendingState && fs.existsSync(pendingState)) {
    const visibilityMarker = pendingState + '.queried';
    if (fs.existsSync(visibilityMarker)) {
      fs.renameSync(pendingState, state);
    } else {
      fs.writeFileSync(visibilityMarker, 'queried');
    }
  }
  if (state && fs.existsSync(state)) {
    process.stdout.write(fs.readFileSync(state, 'utf8'));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ publisher: { publisherName: 'TestPublisher' }, extensionName: 'test-extension', versions: [] }));
  process.exit(0);
}
if (args[0] === 'package') {
  const packaged = spawnSync(process.env.REAL_VSCE, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (packaged.status !== 0) process.exit(packaged.status ?? 1);
  const rival = process.env.RELEASE_TEST_ADVANCE_REPO;
  if (rival) {
    const committed = spawnSync('git', ['commit', '--allow-empty', '-m', 'rival advance'], { cwd: rival, encoding: 'utf8' });
    if (committed.status !== 0) process.exit(committed.status ?? 1);
    const pushed = spawnSync('git', ['push', 'origin', 'main'], { cwd: rival, encoding: 'utf8' });
    if (pushed.status !== 0) process.exit(pushed.status ?? 1);
  }
  process.exit(0);
}
if (args[0] === 'publish') {
  const asset = args[args.indexOf('--packagePath') + 1];
  const state = process.env.RELEASE_TEST_MARKETPLACE_STATE;
  if (state) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
    const metadata = JSON.stringify({
      publisher: { publisherName: 'TestPublisher' },
      extensionName: 'test-extension',
      versions: [{
        version: '1.1.0',
        properties: [{ key: 'Microsoft.VisualStudio.Services.VsixSha256', value: sha256 }],
      }],
    });
    const outputState = process.env.RELEASE_TEST_DELAYED_MARKETPLACE_VISIBILITY
      ? state + '.pending'
      : state;
    fs.writeFileSync(outputState, metadata);
    if (process.env.RELEASE_TEST_DELAYED_MARKETPLACE_VISIBILITY) {
      process.stderr.write('version already exists\\n');
    }
  }
  process.exit(process.env.RELEASE_TEST_AMBIGUOUS_RESPONSES ? 1 : 0);
}
process.exit(1);
`,
    'utf8',
  );
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_CALL_LOG, JSON.stringify({ tool: 'gh', args }) + '\\n');
if (args[0] === '--version') {
  process.stdout.write('gh version test\\n');
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'view') {
  const state = process.env.RELEASE_TEST_GITHUB_STATE;
  if (state && fs.existsSync(state)) {
    process.stdout.write(fs.readFileSync(state, 'utf8'));
    process.exit(0);
  }
  process.stderr.write('release not found\\n');
  process.exit(1);
}
if (args[0] === 'release' && args[1] === 'create') {
  const state = process.env.RELEASE_TEST_GITHUB_STATE;
  if (state) {
    const valueAfter = (name) => args[args.indexOf(name) + 1];
    fs.writeFileSync(state, JSON.stringify({
      tagName: args[2],
      targetCommitish: valueAfter('--target'),
      name: valueAfter('--title'),
      body: fs.readFileSync(valueAfter('--notes-file'), 'utf8'),
      isDraft: args.includes('--draft'),
      assets: [],
    }));
  }
  process.exit(process.env.RELEASE_TEST_AMBIGUOUS_RESPONSES ? 1 : 0);
}
if (args[0] === 'release' && args[1] === 'upload') {
  const state = process.env.RELEASE_TEST_GITHUB_STATE;
  if (state) {
    const asset = args[3];
    const metadata = JSON.parse(fs.readFileSync(state, 'utf8'));
    metadata.assets = [{
      name: path.basename(asset),
      digest: 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex'),
    }];
    fs.writeFileSync(state, JSON.stringify(metadata));
  }
  process.exit(process.env.RELEASE_TEST_AMBIGUOUS_RESPONSES ? 1 : 0);
}
process.exit(0);
`,
    'utf8',
  );
  await chmod(vscePath, 0o755);
  await chmod(ghPath, 0o755);
}

function runRelease(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  return run(process.execPath, [releaseScript, ...args], cwd, env);
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}

function runOk(
  command: string,
  args: string[],
  cwd: string,
): SpawnSyncReturns<string> {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function readToolCalls(path: string): Promise<ToolCall[]> {
  const text = await readFile(path, 'utf8');
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line): ToolCall => {
      const value: unknown = JSON.parse(line);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('tool' in value) ||
        !('args' in value) ||
        typeof value.tool !== 'string' ||
        !Array.isArray(value.args) ||
        !value.args.every((arg) => typeof arg === 'string')
      ) {
        throw new Error(`Invalid tool call log entry: ${line}`);
      }
      return { tool: value.tool, args: value.args };
    });
}
