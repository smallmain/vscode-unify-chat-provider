#!/usr/bin/env bun
/**
 * Interactive release script for this VS Code extension.
 *
 * Features:
 * 1) Bump version (package.json)
 * 2) Generate CHANGELOG.md + GitHub Release notes content
 * 3) Show a summary and wait for confirmation
 * 4) Package & publish to VS Code Marketplace (vsce)
 * 5) Upload VSIX to GitHub Release (gh preferred, otherwise GitHub API)
 *
 * Usage:
 *   bun run scripts/release.ts
 *   bun run scripts/release.ts --dry-run
 *   bun run scripts/release.ts --version 1.2.3
 *   bun run scripts/release.ts --bump patch|minor|major
 *
 * Requirements:
 * - git (clean working tree recommended)
 * - vsce (https://github.com/microsoft/vscode-vsce) for packaging/publishing
 * - For GitHub release upload: gh OR GITHUB_TOKEN
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

type SemverCore = { major: number; minor: number; patch: number };
type Semver = SemverCore & { prerelease?: string; build?: string };

type Commit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
};

type Section = {
  title: string;
  commits: Commit[];
};

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
    'allow-dirty': { type: 'boolean' },
    version: { type: 'string' },
    bump: { type: 'string' },
    'skip-publish': { type: 'boolean' },
    'skip-github': { type: 'boolean' },
    draft: { type: 'boolean' },
  },
});

const dryRun = values['dry-run'] === true;
const yes = values.yes === true;
const allowDirty = values['allow-dirty'] === true;
const providedVersion = typeof values.version === 'string' ? values.version : undefined;
const providedBump = typeof values.bump === 'string' ? values.bump : undefined;
const skipPublish = values['skip-publish'] === true;
const skipGitHub = values['skip-github'] === true;
const githubDraft = values.draft === true;

const rl = createInterface({ input: process.stdin, output: process.stdout });

try {
  const repoRoot = process.cwd();

  const pkgPath = join(repoRoot, 'package.json');
  const pkgText = await readTextFile(pkgPath);
  const pkgJson = parseJsonObject(pkgText, pkgPath);

  const extensionName = getRequiredString(pkgJson, 'name', pkgPath);
  const currentVersion = getRequiredString(pkgJson, 'version', pkgPath);

  const currentSemver = parseSemver(currentVersion);
  if (!currentSemver) {
    throw new Error(`Invalid semver in ${pkgPath}: ${currentVersion}`);
  }

  await assertGitRepo(repoRoot);
  await assertGitClean(repoRoot, dryRun || allowDirty);

  const nextVersion = await resolveNextVersion({
    current: currentSemver,
    currentRaw: currentVersion,
    providedVersion,
    providedBump,
    yes,
    rl,
  });

  const tagName = `v${nextVersion}`;
  const date = formatDate(new Date());

  const branch = (await runCapture(repoRoot, 'git', ['branch', '--show-current'])).stdout.trim();
  const headSha = (await runCapture(repoRoot, 'git', ['rev-parse', 'HEAD'])).stdout.trim();
  const baseTag = await getLatestGitTag(repoRoot);
  const range = baseTag ? `${baseTag}..HEAD` : 'HEAD';
  const commits = await getCommits(repoRoot, range);

  const sections = groupCommits(commits);
  const changelogEntry = renderChangelogEntry({ version: nextVersion, date, sections });

  // Create temp file for user to edit changelog
  const changelogTempFile = await writeChangelogTempFile(changelogEntry);

  printSummary({
    extensionName,
    currentVersion,
    nextVersion,
    tagName,
    branch,
    headSha,
    baseTag,
    commits,
    skipPublish,
    skipGitHub,
    dryRun,
    changelogTempFile,
  });

  if (!yes) {
    const proceed = await confirm(
      rl,
      'Continue with version/changelog update, packaging, and publishing?',
      false,
    );
    if (!proceed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Read back the (possibly edited) changelog content
  const finalChangelogEntry = await readTextFile(changelogTempFile);
  const githubReleaseNotes = changelogToGitHubReleaseNotes(finalChangelogEntry);

  if (dryRun) {
    console.log('Dry-run: no files modified and no commands executed.');
    process.exit(0);
  }

  await updatePackageJsonVersion(pkgPath, pkgText, nextVersion);
  await upsertChangelog(join(repoRoot, 'CHANGELOG.md'), finalChangelogEntry);

  const doCommitAndTag = yes
    ? true
    : await confirm(rl, `Create git commit + tag ${tagName}?`, true);
  if (doCommitAndTag) {
    await runInherit(repoRoot, 'git', ['add', 'package.json', 'CHANGELOG.md']);
    await runInherit(repoRoot, 'git', ['commit', '-m', `chore(release): ${tagName}`]);
  }

  const vsixPath = join(repoRoot, `${extensionName}-${nextVersion}.vsix`);
  await runInherit(repoRoot, 'vsce', ['package', '--out', vsixPath, '--allow-all-proposed-apis']);

  if (!skipPublish) {
    await runInherit(repoRoot, 'vsce', ['publish', '--packagePath', vsixPath]);
  }

  // Create git tag after successful packaging/publishing to avoid manual cleanup on failure
  if (doCommitAndTag) {
    await ensureGitTag(repoRoot, tagName);
  }

  if (!skipGitHub) {
    await publishGitHubRelease({
      repoRoot,
      tagName,
      title: tagName,
      notes: githubReleaseNotes,
      targetCommitish: headSha,
      assetPath: vsixPath,
      draft: githubDraft,
    });
  }

  console.log('Done.');
} finally {
  rl.close();
}

async function assertGitRepo(cwd: string): Promise<void> {
  try {
    const result = await runCapture(cwd, 'git', ['rev-parse', '--is-inside-work-tree']);
    if (result.stdout.trim() !== 'true') {
      throw new Error('Not a git repository.');
    }
  } catch (error) {
    throw new Error(`git is required and must be run inside a git repo. (${String(error)})`);
  }
}

async function assertGitClean(cwd: string, allowDirty: boolean): Promise<void> {
  const status = (await runCapture(cwd, 'git', ['status', '--porcelain'])).stdout.trim();
  if (!status) {
    return;
  }
  if (allowDirty) {
    console.warn('Warning: working tree is not clean; continuing.');
    return;
  }
  console.error('Working tree is not clean:\n' + status);
  throw new Error('Please commit/stash changes before releasing.');
}

async function resolveNextVersion(params: {
  current: Semver;
  currentRaw: string;
  providedVersion: string | undefined;
  providedBump: string | undefined;
  yes: boolean;
  rl: ReturnType<typeof createInterface>;
}): Promise<string> {
  const { current, currentRaw, providedVersion, providedBump, yes, rl } = params;

  if (providedVersion) {
    const parsed = parseSemver(providedVersion);
    if (!parsed) {
      throw new Error(`Invalid --version: ${providedVersion}`);
    }
    return providedVersion;
  }

  const bump = normalizeBump(providedBump);
  if (bump) {
    return formatSemver(bumpSemver(current, bump));
  }

  const nextPatch = formatSemver(bumpSemver(current, 'patch'));
  const nextMinor = formatSemver(bumpSemver(current, 'minor'));
  const nextMajor = formatSemver(bumpSemver(current, 'major'));

  if (yes) {
    return nextPatch;
  }

  console.log(`Current version: ${currentRaw}`);
  console.log('Select next version:');
  console.log(`  1) patch  → ${nextPatch}`);
  console.log(`  2) minor  → ${nextMinor}`);
  console.log(`  3) major  → ${nextMajor}`);
  console.log('  4) custom');

  while (true) {
    const choice = (await rl.question('Enter choice (1-4): ')).trim();
    if (choice === '1') return nextPatch;
    if (choice === '2') return nextMinor;
    if (choice === '3') return nextMajor;
    if (choice === '4') {
      const custom = (await rl.question('Enter version (semver): ')).trim();
      const parsed = parseSemver(custom);
      if (parsed) {
        return custom;
      }
      console.log(`Invalid semver: ${custom}`);
      continue;
    }
    console.log('Invalid choice.');
  }
}

function normalizeBump(value: string | undefined): 'patch' | 'minor' | 'major' | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'patch' || normalized === 'minor' || normalized === 'major') {
    return normalized;
  }
  throw new Error(`Invalid --bump: ${value} (expected patch|minor|major)`);
}

function parseSemver(input: string): Semver | null {
  const trimmed = input.trim();
  const match =
    /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      trimmed,
    );
  if (!match || !match.groups) {
    return null;
  }
  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  const prerelease = match.groups.prerelease || undefined;
  const build = match.groups.build || undefined;
  return { major, minor, patch, prerelease, build };
}

function bumpSemver(current: Semver, bump: 'patch' | 'minor' | 'major'): Semver {
  if (bump === 'patch') return { major: current.major, minor: current.minor, patch: current.patch + 1 };
  if (bump === 'minor') return { major: current.major, minor: current.minor + 1, patch: 0 };
  return { major: current.major + 1, minor: 0, patch: 0 };
}

function formatSemver(version: Semver): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  const prerelease = version.prerelease ? `-${version.prerelease}` : '';
  const build = version.build ? `+${version.build}` : '';
  return `${core}${prerelease}${build}`;
}

async function getLatestGitTag(cwd: string): Promise<string | null> {
  try {
    const result = await runCapture(cwd, 'git', ['describe', '--tags', '--abbrev=0']);
    const tag = result.stdout.trim();
    return tag ? tag : null;
  } catch {
    return null;
  }
}

async function getCommits(cwd: string, range: string): Promise<Commit[]> {
  const format = '%H%x09%s%x09%an';
  const result = await runCapture(cwd, 'git', ['log', range, '--no-merges', `--pretty=format:${format}`]);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const commits: Commit[] = [];
  for (const line of lines) {
    const [hash, subject, author] = line.split('\t');
    if (!hash || !subject || !author) {
      continue;
    }
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      subject,
      author,
    });
  }
  return commits;
}

function groupCommits(commits: Commit[]): Section[] {
  const buckets: Record<string, Commit[]> = {};

  const pushTo = (title: string, commit: Commit) => {
    const list = buckets[title] ?? [];
    list.push(commit);
    buckets[title] = list;
  };

  for (const commit of commits) {
    const parsed = parseConventionalSubject(commit.subject);
    if (parsed?.breaking) {
      pushTo('Breaking Changes', commit);
      continue;
    }
    const type = parsed?.type ?? null;
    if (type === 'feat') pushTo('Features', commit);
    else if (type === 'fix') pushTo('Fixes', commit);
    else if (type === 'docs') pushTo('Docs', commit);
    else if (type === 'refactor') pushTo('Refactors', commit);
    else if (type === 'perf') pushTo('Performance', commit);
    else if (type === 'test') pushTo('Tests', commit);
    else if (type === 'build' || type === 'ci') pushTo('Build/CI', commit);
    else if (type === 'chore' || type === 'style') pushTo('Chores', commit);
    else pushTo('Other', commit);
  }

  const order = [
    'Breaking Changes',
    'Features',
    'Fixes',
    'Performance',
    'Refactors',
    'Docs',
    'Build/CI',
    'Tests',
    'Chores',
    'Other',
  ];

  const sections: Section[] = [];
  for (const title of order) {
    const list = buckets[title];
    if (list && list.length > 0) {
      sections.push({ title, commits: list });
    }
  }
  if (sections.length === 0) {
    sections.push({ title: 'Other', commits: [] });
  }
  return sections;
}

function parseConventionalSubject(
  subject: string,
): { type: string; scope?: string; breaking: boolean; description: string } | null {
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
  if (!match) {
    return null;
  }
  const type = match[1].toLowerCase();
  const scope = match[2] ? match[2].trim() : undefined;
  const breaking = match[3] === '!';
  const description = match[4] ?? '';
  return { type, scope, breaking, description };
}

function formatCommitTitle(commit: Commit): string {
  const parsed = parseConventionalSubject(commit.subject);
  if (!parsed) {
    return commit.subject;
  }
  const scopePrefix = parsed.scope ? `${parsed.scope}: ` : '';
  return `${scopePrefix}${parsed.description}`;
}

function renderChangelogEntry(params: {
  version: string;
  date: string;
  sections: Section[];
}): string {
  const lines: string[] = [];
  lines.push(`## v${params.version} - ${params.date}`, '');
  const hasCommits = params.sections.some(s => s.commits.length > 0);
  if (!hasCommits) {
    lines.push('- No changes recorded.', '');
    return lines.join('\n');
  }
  for (const section of params.sections) {
    if (section.commits.length === 0) {
      continue;
    }
    lines.push(`### ${section.title}`);
    for (const commit of section.commits) {
      lines.push(`- ${formatCommitTitle(commit)} (${commit.shortHash}, ${commit.author})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function printSummary(params: {
  extensionName: string;
  currentVersion: string;
  nextVersion: string;
  tagName: string;
  branch: string;
  headSha: string;
  baseTag: string | null;
  commits: Commit[];
  skipPublish: boolean;
  skipGitHub: boolean;
  dryRun: boolean;
  changelogTempFile: string;
}): void {
  console.log('');
  console.log('Release summary');
  console.log('===============');
  console.log(`- Extension: ${params.extensionName}`);
  console.log(`- Version:   ${params.currentVersion} → ${params.nextVersion}`);
  console.log(`- Tag:       ${params.tagName}`);
  console.log(`- Branch:    ${params.branch}`);
  console.log(`- Commit:    ${params.headSha}`);
  console.log(`- Base tag:  ${params.baseTag ?? '(none)'}`);
  console.log(`- Commits:   ${params.commits.length} (range: ${params.baseTag ? `${params.baseTag}..HEAD` : 'HEAD'})`);
  console.log(`- Publish:   ${params.skipPublish ? 'skip' : 'VS Code Marketplace (vsce publish)'}`);
  console.log(`- GitHub:    ${params.skipGitHub ? 'skip' : 'Create Release + upload VSIX'}`);
  console.log(`- Mode:      ${params.dryRun ? 'dry-run' : 'live'}`);
  console.log('');
  console.log(`Edit changelog: ${params.changelogTempFile}`);
  console.log('');
}

async function updatePackageJsonVersion(
  pkgPath: string,
  originalText: string,
  nextVersion: string,
): Promise<void> {
  const pkgJson = parseJsonObject(originalText, pkgPath);
  pkgJson.version = nextVersion;
  await writeFile(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8');
}

async function upsertChangelog(changelogPath: string, entry: string): Promise<void> {
  const header = '# Changelog';
  const exists = await fileExists(changelogPath);
  if (!exists) {
    await writeFile(changelogPath, `${header}\n\n${entry.trimEnd()}\n`, 'utf8');
    return;
  }

  const existing = await readTextFile(changelogPath);
  const normalized = existing.replace(/\r\n/g, '\n');

  const headerMatch = /^#\s*Changelog\s*\n(\n)*/.exec(normalized);
  if (!headerMatch) {
    const merged = `${header}\n\n${entry.trimEnd()}\n\n${normalized.trimStart()}`;
    await writeFile(changelogPath, `${merged.replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');
    return;
  }

  const insertAt = headerMatch[0].length;
  const merged = `${normalized.slice(0, insertAt)}${entry.trimEnd()}\n\n${normalized.slice(insertAt).trimStart()}`;
  await writeFile(changelogPath, `${merged.replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');
}

async function ensureGitTag(cwd: string, tagName: string): Promise<void> {
  const existing = (await runCapture(cwd, 'git', ['tag', '--list', tagName])).stdout.trim();
  if (existing === tagName) {
    console.log(`Tag already exists: ${tagName}`);
    return;
  }
  await runInherit(cwd, 'git', ['tag', '-a', tagName, '-m', tagName]);
}

async function publishGitHubRelease(params: {
  repoRoot: string;
  tagName: string;
  title: string;
  notes: string;
  targetCommitish: string;
  assetPath: string;
  draft: boolean;
}): Promise<void> {
  if (await canRun(params.repoRoot, 'gh', ['--version'])) {
    const notesFile = await writeTempNotes(params.notes);
    const args = [
      'release',
      'create',
      params.tagName,
      params.assetPath,
      '--title',
      params.title,
      '--notes-file',
      notesFile,
    ];
    if (params.draft) {
      args.push('--draft');
    }
    await runInherit(params.repoRoot, 'gh', args);
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GitHub upload requires gh or GITHUB_TOKEN.');
  }

  const repoSlug = await resolveGitHubRepoSlug(params.repoRoot);
  if (!repoSlug) {
    throw new Error('Unable to determine GitHub repository (owner/repo).');
  }

  const release = await createGitHubRelease({
    repoSlug,
    token,
    tagName: params.tagName,
    title: params.title,
    body: params.notes,
    targetCommitish: params.targetCommitish,
    draft: params.draft,
  });

  await uploadGitHubReleaseAsset({
    uploadUrlTemplate: release.upload_url,
    token,
    assetPath: params.assetPath,
  });
}

async function resolveGitHubRepoSlug(repoRoot: string): Promise<string | null> {
  const pkgPath = join(repoRoot, 'package.json');
  try {
    const pkgText = await readTextFile(pkgPath);
    const pkgJson = parseJsonObject(pkgText, pkgPath);
    const repoField = pkgJson.repository;
    const slugFromPkg = extractGitHubSlugFromRepository(repoField);
    if (slugFromPkg) return slugFromPkg;
  } catch {
    // ignore and fallback to git remote
  }

  try {
    const origin = (await runCapture(repoRoot, 'git', ['remote', 'get-url', 'origin'])).stdout.trim();
    return parseGitHubSlug(origin);
  } catch {
    return null;
  }
}

function extractGitHubSlugFromRepository(value: unknown): string | null {
  if (typeof value === 'string') {
    return parseGitHubSlug(value);
  }
  if (isRecord(value) && typeof value.url === 'string') {
    return parseGitHubSlug(value.url);
  }
  return null;
}

function parseGitHubSlug(input: string): string | null {
  const trimmed = input.trim();

  const githubPrefix = /^github:([^/]+)\/([^#]+)$/i.exec(trimmed);
  if (githubPrefix) {
    return `${githubPrefix[1]}/${stripGitSuffix(githubPrefix[2])}`;
  }

  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh) {
    return `${ssh[1]}/${stripGitSuffix(ssh[2])}`;
  }

  const https = /^https?:\/\/github\.com\/([^/]+)\/(.+)$/.exec(trimmed.replace(/^git\+/, ''));
  if (https) {
    const repo = https[2].split('/')[0] ?? https[2];
    return `${https[1]}/${stripGitSuffix(repo)}`;
  }

  return null;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

async function createGitHubRelease(params: {
  repoSlug: string;
  token: string;
  tagName: string;
  title: string;
  body: string;
  targetCommitish: string;
  draft: boolean;
}): Promise<{ upload_url: string }> {
  const url = `https://api.github.com/repos/${params.repoSlug}/releases`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vscode-unify-chat-provider-release-script',
    },
    body: JSON.stringify({
      tag_name: params.tagName,
      name: params.title,
      body: params.body,
      target_commitish: params.targetCommitish,
      draft: params.draft,
      prerelease: false,
    }),
  });

  if (!response.ok) {
    const message = await safeReadResponseText(response);
    throw new Error(`GitHub release create failed (${response.status}): ${message}`);
  }

  const json: unknown = await response.json();
  if (!isRecord(json) || typeof json.upload_url !== 'string') {
    throw new Error('Unexpected GitHub release response.');
  }
  return { upload_url: json.upload_url };
}

async function uploadGitHubReleaseAsset(params: {
  uploadUrlTemplate: string;
  token: string;
  assetPath: string;
}): Promise<void> {
  const uploadBase = params.uploadUrlTemplate.replace(/\{.*\}$/, '');
  const filename = basename(params.assetPath);
  const url = new URL(uploadBase);
  url.searchParams.set('name', filename);

  const bytes = await readFile(params.assetPath);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/octet-stream',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vscode-unify-chat-provider-release-script',
    },
    body: bytes,
  });

  if (!response.ok) {
    const message = await safeReadResponseText(response);
    throw new Error(`GitHub asset upload failed (${response.status}): ${message}`);
  }
}

async function writeTempNotes(notes: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'release-notes-'));
  const file = join(dir, 'notes.md');
  await writeFile(file, notes.trimEnd() + '\n', 'utf8');
  return file;
}

async function writeChangelogTempFile(changelogEntry: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'release-changelog-'));
  const file = join(dir, 'CHANGELOG_EDIT.md');
  await writeFile(file, changelogEntry.trimEnd() + '\n', 'utf8');
  return file;
}

function changelogToGitHubReleaseNotes(changelogEntry: string): string {
  // Convert CHANGELOG format "## v1.0.0 - 2025-01-01" to GitHub format "## v1.0.0 (2025-01-01)"
  return changelogEntry.replace(/^(## v[\d.]+) - (\d{4}-\d{2}-\d{2})/, '$1 ($2)');
}

async function confirm(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await rl.question(prompt + suffix)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

async function canRun(cwd: string, command: string, args: string[]): Promise<boolean> {
  try {
    await runCapture(cwd, command, args);
    return true;
  } catch {
    return false;
  }
}

type RunResult = { stdout: string; stderr: string };

async function runCapture(cwd: string, command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
      }
    });
  });
}

async function runInherit(cwd: string, command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${code})`));
    });
  });
}

function formatDate(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(text: string, sourcePath: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${sourcePath} (${String(error)})`);
  }
  if (!isRecord(value)) {
    throw new Error(`Expected a JSON object in ${sourcePath}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRequiredString(
  obj: Record<string, unknown>,
  key: string,
  sourcePath: string,
): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or invalid "${key}" in ${sourcePath}.`);
  }
  return value;
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(failed to read response body)';
  }
}
