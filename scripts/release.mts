#!/usr/bin/env node
/**
 * Interactive release script for this VS Code extension.
 *
 * Features:
 * 1) Bump version (package.json)
 * 2) Generate CHANGELOG.md + GitHub Release notes content
 * 3) Show a summary and wait for confirmation
 * 4) Package & publish to VS Code Marketplace (vsce)
 * 5) Create GitHub Release, then upload VSIX (gh preferred, otherwise GitHub API)
 *
 * Usage:
 *   node scripts/release.mts
 *   node scripts/release.mts --dry-run
 *   node scripts/release.mts --version 1.2.3
 *   node scripts/release.mts --bump patch|minor|major
 *   node scripts/release.mts --github-tag v1.2.3
 *   node scripts/release.mts --github-tag v1.2.3 --skip-github-upload
 *   node scripts/release.mts --github-tag v1.2.3 --skip-github-create --github-asset path/to/file.vsix
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

const MARKETPLACE_PUBLISH_ATTEMPTS = 4;

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
    'allow-dirty': { type: 'boolean' },
    version: { type: 'string' },
    bump: { type: 'string' },
    'github-tag': { type: 'string' },
    'github-asset': { type: 'string' },
    'github-notes-file': { type: 'string' },
    'skip-publish': { type: 'boolean' },
    'skip-github': { type: 'boolean' },
    'skip-github-create': { type: 'boolean' },
    'skip-github-upload': { type: 'boolean' },
    draft: { type: 'boolean' },
  },
});

const dryRun = values['dry-run'] === true;
const yes = values.yes === true;
const allowDirty = values['allow-dirty'] === true;
const providedVersion =
  typeof values.version === 'string' ? values.version : undefined;
const providedBump = typeof values.bump === 'string' ? values.bump : undefined;
const githubTagInput =
  typeof values['github-tag'] === 'string' ? values['github-tag'] : undefined;
const githubAssetInput =
  typeof values['github-asset'] === 'string'
    ? values['github-asset']
    : undefined;
const githubNotesFileInput =
  typeof values['github-notes-file'] === 'string'
    ? values['github-notes-file']
    : undefined;
const skipPublish = values['skip-publish'] === true;
const skipGitHub = values['skip-github'] === true;
const skipGitHubCreate = skipGitHub || values['skip-github-create'] === true;
const skipGitHubUpload = skipGitHub || values['skip-github-upload'] === true;
const githubDraft = values.draft === true;

await main();

async function main(): Promise<void> {
  let rl: ReturnType<typeof createInterface> | null = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const repoRoot = process.cwd();

  const pkgPath = join(repoRoot, 'package.json');
  const packageLockPath = join(repoRoot, 'package-lock.json');
  const pkgText = await readTextFile(pkgPath);
  const pkgJson = parseJsonObject(pkgText, pkgPath);

  const extensionName = getRequiredString(pkgJson, 'name', pkgPath);
  const currentVersion = getRequiredString(pkgJson, 'version', pkgPath);

  const currentSemver = parseSemver(currentVersion);
  if (!currentSemver) {
    throw new Error(`Invalid semver in ${pkgPath}: ${currentVersion}`);
  }

  await assertGitRepo(repoRoot);

  if (githubTagInput) {
    await runGitHubFromTagMode({
      repoRoot,
      extensionName,
      githubTagInput,
      githubAssetInput,
      githubNotesFileInput,
      skipGitHubCreate,
      skipGitHubUpload,
      githubDraft,
      yes,
      dryRun,
      rl,
    });
    return;
  }

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

  const branch = (
    await runCapture(repoRoot, 'git', ['branch', '--show-current'])
  ).stdout.trim();
  const headSha = (
    await runCapture(repoRoot, 'git', ['rev-parse', 'HEAD'])
  ).stdout.trim();
  const baseTag = await getLatestGitTag(repoRoot);
  const range = baseTag ? `${baseTag}..HEAD` : 'HEAD';
  const commits = await getCommits(repoRoot, range);

  const sections = groupCommits(commits);
  const changelogEntry = renderChangelogEntry({
    version: nextVersion,
    date,
    sections,
  });

  const changelogTempFile = dryRun
    ? null
    : await writeChangelogTempFile(changelogEntry);

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
    skipGitHubCreate,
    skipGitHubUpload,
    dryRun,
    changelogTempFile,
  });

  if (changelogTempFile === null) {
    console.log(
      'Dry-run: no repository files modified and no mutating commands executed.',
    );
    return;
  }

  if (!yes) {
    const proceed = await confirm(
      rl,
      'Continue with the release commit, tag, packaging, and publishing?',
      false,
    );
    if (!proceed) {
      console.log('Aborted.');
      return;
    }
  }

  // Read back the (possibly edited) changelog content
  const finalChangelogEntry = await readTextFile(changelogTempFile);
  const githubReleaseNotes = changelogToGitHubReleaseNotes(finalChangelogEntry);

  const packageLockText = await readTextFile(packageLockPath);
  await updatePackageVersions({
    pkgPath,
    pkgText,
    packageLockPath,
    packageLockText,
    nextVersion,
  });
  await upsertChangelog(join(repoRoot, 'CHANGELOG.md'), finalChangelogEntry);

  rl.close();
  rl = null;

  await runInherit(repoRoot, 'git', [
    'add',
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
  ]);
  await runInherit(repoRoot, 'git', [
    'commit',
    '-m',
    `chore(release): ${tagName}`,
  ]);
  const releaseSha = (
    await runCapture(repoRoot, 'git', ['rev-parse', 'HEAD'])
  ).stdout.trim();

  const vsixPath = join(repoRoot, `${extensionName}-${nextVersion}.vsix`);
  await runInherit(repoRoot, 'vsce', ['package', '--out', vsixPath]);

  if (!skipPublish) {
    await publishToMarketplace(repoRoot, vsixPath);
  }

  // Create git tag after successful packaging/publishing to avoid manual cleanup on failure
  await ensureGitTag(repoRoot, tagName);
  // Push tag to remote for GitHub release
  await runInherit(repoRoot, 'git', ['push', 'origin', tagName]);

  if (!skipGitHubCreate || !skipGitHubUpload) {
    await publishGitHubRelease({
      repoRoot,
      tagName,
      title: tagName,
      notes: githubReleaseNotes,
      targetCommitish: releaseSha,
      assetPath: vsixPath,
      draft: githubDraft,
      skipCreate: skipGitHubCreate,
      skipUpload: skipGitHubUpload,
    });
  }

  console.log('Done.');
} finally {
  rl?.close();
}
}

async function assertGitRepo(cwd: string): Promise<void> {
  try {
    const result = await runCapture(cwd, 'git', [
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (result.stdout.trim() !== 'true') {
      throw new Error('Not a git repository.');
    }
  } catch (error) {
    throw new Error(
      `git is required and must be run inside a git repo. (${String(error)})`,
    );
  }
}

async function assertGitClean(cwd: string, allowDirty: boolean): Promise<void> {
  const status = (
    await runCapture(cwd, 'git', ['status', '--porcelain'])
  ).stdout.trim();
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
  const { current, currentRaw, providedVersion, providedBump, yes, rl } =
    params;

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

function normalizeBump(
  value: string | undefined,
): 'patch' | 'minor' | 'major' | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'patch' ||
    normalized === 'minor' ||
    normalized === 'major'
  ) {
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
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    !Number.isInteger(patch)
  ) {
    return null;
  }
  const prerelease = match.groups.prerelease || undefined;
  const build = match.groups.build || undefined;
  return { major, minor, patch, prerelease, build };
}

function bumpSemver(
  current: Semver,
  bump: 'patch' | 'minor' | 'major',
): Semver {
  if (bump === 'patch')
    return {
      major: current.major,
      minor: current.minor,
      patch: current.patch + 1,
    };
  if (bump === 'minor')
    return { major: current.major, minor: current.minor + 1, patch: 0 };
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
    const result = await runCapture(cwd, 'git', [
      'describe',
      '--tags',
      '--abbrev=0',
    ]);
    const tag = result.stdout.trim();
    return tag ? tag : null;
  } catch {
    return null;
  }
}

async function getCommits(cwd: string, range: string): Promise<Commit[]> {
  const format = '%H%x09%s%x09%an';
  const result = await runCapture(cwd, 'git', [
    'log',
    range,
    '--no-merges',
    `--pretty=format:${format}`,
  ]);
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

function parseConventionalSubject(subject: string): {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
} | null {
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
  const hasCommits = params.sections.some((s) => s.commits.length > 0);
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
      lines.push(
        `- ${formatCommitTitle(commit)} (${commit.shortHash}, ${
          commit.author
        })`,
      );
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
  skipGitHubCreate: boolean;
  skipGitHubUpload: boolean;
  dryRun: boolean;
  changelogTempFile: string | null;
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
  console.log(
    `- Commits:   ${params.commits.length} (range: ${
      params.baseTag ? `${params.baseTag}..HEAD` : 'HEAD'
    })`,
  );
  console.log(
    `- Publish:   ${
      params.skipPublish ? 'skip' : 'VS Code Marketplace (vsce publish)'
    }`,
  );
  console.log(
    `- GitHub:    ${[
      params.skipGitHubCreate ? 'create=skip' : 'create=on',
      params.skipGitHubUpload ? 'upload=skip' : 'upload=on',
    ].join(', ')}`,
  );
  console.log(`- Mode:      ${params.dryRun ? 'dry-run' : 'live'}`);
  if (params.changelogTempFile !== null) {
    console.log('');
    console.log(`Edit changelog: ${params.changelogTempFile}`);
  }
  console.log('');
}

function printGitHubFromTagSummary(params: {
  tagName: string;
  tagCommit: string;
  notesSource: string;
  assetPath: string | null;
  skipGitHubCreate: boolean;
  skipGitHubUpload: boolean;
  dryRun: boolean;
}): void {
  console.log('');
  console.log('GitHub release (from existing tag)');
  console.log('=================================');
  console.log(`- Tag:       ${params.tagName}`);
  console.log(`- Commit:    ${params.tagCommit}`);
  console.log(`- Notes:     ${params.notesSource}`);
  console.log(`- Asset:     ${params.assetPath ?? '(none)'}`);
  console.log(
    `- GitHub:    ${[
      params.skipGitHubCreate ? 'create=skip' : 'create=on',
      params.skipGitHubUpload ? 'upload=skip' : 'upload=on',
    ].join(', ')}`,
  );
  console.log(`- Mode:      ${params.dryRun ? 'dry-run' : 'live'}`);
  console.log('');
}

async function updatePackageVersions(params: {
  pkgPath: string;
  pkgText: string;
  packageLockPath: string;
  packageLockText: string;
  nextVersion: string;
}): Promise<void> {
  const pkgJson = parseJsonObject(params.pkgText, params.pkgPath);
  pkgJson.version = params.nextVersion;

  const packageLockJson = parseJsonObject(
    params.packageLockText,
    params.packageLockPath,
  );
  const packages = packageLockJson.packages;
  if (!isRecord(packages)) {
    throw new Error(`Missing or invalid "packages" in ${params.packageLockPath}.`);
  }
  const rootPackage = packages[''];
  if (!isRecord(rootPackage)) {
    throw new Error(
      `Missing or invalid root package entry in ${params.packageLockPath}.`,
    );
  }

  packageLockJson.version = params.nextVersion;
  rootPackage.version = params.nextVersion;

  await writeFile(
    params.pkgPath,
    `${JSON.stringify(pkgJson, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    params.packageLockPath,
    `${JSON.stringify(packageLockJson, null, 2)}\n`,
    'utf8',
  );
}

async function upsertChangelog(
  changelogPath: string,
  entry: string,
): Promise<void> {
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
    await writeFile(
      changelogPath,
      `${merged.replace(/\n{3,}/g, '\n\n')}\n`,
      'utf8',
    );
    return;
  }

  const insertAt = headerMatch[0].length;
  const merged = `${normalized.slice(
    0,
    insertAt,
  )}${entry.trimEnd()}\n\n${normalized.slice(insertAt).trimStart()}`;
  await writeFile(
    changelogPath,
    `${merged.replace(/\n{3,}/g, '\n\n')}\n`,
    'utf8',
  );
}

async function ensureGitTag(cwd: string, tagName: string): Promise<void> {
  const existing = (
    await runCapture(cwd, 'git', ['tag', '--list', tagName])
  ).stdout.trim();
  if (existing === tagName) {
    console.log(`Tag already exists: ${tagName}`);
    return;
  }
  await runInherit(cwd, 'git', ['tag', '-a', tagName, '-m', tagName]);
}

async function publishToMarketplace(
  repoRoot: string,
  vsixPath: string,
): Promise<void> {
  const args = [
    'publish',
    '--packagePath',
    vsixPath,
    '--allow-all-proposed-apis',
  ];

  await retry(
    MARKETPLACE_PUBLISH_ATTEMPTS,
    async () => {
      const result = await runInheritCaptureWithCode(repoRoot, 'vsce', args);
      if (result.code === 0) {
        return;
      }

      const output = `${result.stderr}\n${result.stdout}`;
      if (isMarketplaceAlreadyPublishedError(output)) {
        console.warn(
          'VS Code Marketplace already has this extension version; treating publish as complete.',
        );
        return;
      }

      throw new Error(
        `vsce ${args.join(' ')} failed (${String(result.code)})`,
      );
    },
    (attempt, error) => {
      console.warn(
        `VS Code Marketplace publish failed (attempt ${attempt}/${MARKETPLACE_PUBLISH_ATTEMPTS}): ${formatError(
          error,
        )}`,
      );
      console.warn(
        'Tip: Marketplace publishing can fail on transient /_apis/gallery timeouts; the release script will retry before continuing.',
      );
    },
  );
}

function isMarketplaceAlreadyPublishedError(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes('already exists') ||
    normalized.includes('version already exists') ||
    normalized.includes('this extension version has already been published') ||
    normalized.includes('a version of this extension already exists')
  );
}

async function runGitHubFromTagMode(params: {
  repoRoot: string;
  extensionName: string;
  githubTagInput: string;
  githubAssetInput: string | undefined;
  githubNotesFileInput: string | undefined;
  skipGitHubCreate: boolean;
  skipGitHubUpload: boolean;
  githubDraft: boolean;
  yes: boolean;
  dryRun: boolean;
  rl: ReturnType<typeof createInterface> | null;
}): Promise<void> {
  const tagName = normalizeGitTag(params.githubTagInput);
  const versionFromTag = tagName.startsWith('v') ? tagName.slice(1) : tagName;

  const tagExists = (
    await runCapture(params.repoRoot, 'git', ['tag', '--list', tagName])
  ).stdout.trim();
  if (tagExists !== tagName) {
    throw new Error(`Git tag not found: ${tagName}`);
  }

  const tagCommit = (
    await runCapture(params.repoRoot, 'git', ['rev-parse', `${tagName}^{}`])
  ).stdout.trim();

  const changelogPath = join(params.repoRoot, 'CHANGELOG.md');

  let notesSource = `CHANGELOG.md (${tagName})`;
  let notes: string;
  if (params.githubNotesFileInput) {
    notesSource = params.githubNotesFileInput;
    notes = await readTextFile(params.githubNotesFileInput);
  } else {
    const changelogText = await readTextFile(changelogPath);
    const entry = extractChangelogEntryForTag(changelogText, tagName);
    if (!entry) {
      throw new Error(
        `Unable to find ${tagName} entry in ${changelogPath}. Pass --github-notes-file to provide release notes.`,
      );
    }
    notes = changelogToGitHubReleaseNotes(entry);
  }

  const defaultAssetPath = join(
    params.repoRoot,
    `${params.extensionName}-${versionFromTag}.vsix`,
  );
  const assetPath = params.githubAssetInput ?? defaultAssetPath;
  const assetExists = await fileExists(assetPath);
  const resolvedAssetPath =
    params.skipGitHubUpload || !assetExists ? null : assetPath;

  if (!params.skipGitHubUpload && !resolvedAssetPath) {
    throw new Error(
      `GitHub upload requested but asset not found: ${assetPath}. Pass --skip-github-upload or build/package the VSIX first.`,
    );
  }

  printGitHubFromTagSummary({
    tagName,
    tagCommit,
    notesSource,
    assetPath: resolvedAssetPath,
    skipGitHubCreate: params.skipGitHubCreate,
    skipGitHubUpload: params.skipGitHubUpload,
    dryRun: params.dryRun,
  });

  if (params.dryRun) {
    console.log('Dry-run: no mutating commands executed.');
    return;
  }

  if (!params.yes && params.rl) {
    const proceed = await confirm(
      params.rl,
      'Continue with GitHub release create/upload?',
      false,
    );
    if (!proceed) {
      console.log('Aborted.');
      return;
    }
  }

  if (!params.skipGitHubCreate || !params.skipGitHubUpload) {
    await publishGitHubRelease({
      repoRoot: params.repoRoot,
      tagName,
      title: tagName,
      notes,
      targetCommitish: tagCommit,
      assetPath: resolvedAssetPath ?? assetPath,
      draft: params.githubDraft,
      skipCreate: params.skipGitHubCreate,
      skipUpload: params.skipGitHubUpload,
    });
  }
}

function normalizeGitTag(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('v')) {
    return trimmed;
  }
  const semver = parseSemver(trimmed);
  if (semver) {
    return `v${formatSemver(semver)}`;
  }
  return trimmed;
}

function extractChangelogEntryForTag(
  changelogText: string,
  tagName: string,
): string | null {
  const normalized = changelogText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headerPrefix = `## ${tagName} - `;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith(headerPrefix)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith('## v')) {
      end = i;
      break;
    }
  }

  const entry = lines.slice(start, end).join('\n').trimEnd();
  return entry ? `${entry}\n` : null;
}

async function publishGitHubRelease(params: {
  repoRoot: string;
  tagName: string;
  title: string;
  notes: string;
  targetCommitish: string;
  assetPath: string;
  draft: boolean;
  skipCreate: boolean;
  skipUpload: boolean;
}): Promise<void> {
  if (params.skipCreate && params.skipUpload) {
    return;
  }

  const ghEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'dumb',
  };

  if (await canRun(params.repoRoot, 'gh', ['--version'])) {
    const notesFile = await writeTempNotes(params.notes);

    if (!params.skipCreate) {
      console.log(`Creating GitHub Release: ${params.tagName}`);
      const args = [
        'release',
        'create',
        params.tagName,
        '--title',
        params.title,
        '--notes-file',
        notesFile,
        '--target',
        params.targetCommitish,
      ];
      if (params.draft) {
        args.push('--draft');
      }

      const result = await runCaptureWithCode(params.repoRoot, 'gh', args, {
        env: ghEnv,
      });
      if (result.code !== 0) {
        const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
        if (combined.includes('already exists')) {
          console.log(`GitHub Release already exists: ${params.tagName}`);
        } else {
          throw new Error(
            `gh release create failed (${String(result.code)}): ${result.stderr || result.stdout}`,
          );
        }
      } else if (result.stdout.trim() || result.stderr.trim()) {
        const output = (result.stdout || result.stderr).trimEnd();
        if (output) {
          console.log(output);
        }
      }
    }

    if (!params.skipUpload) {
      console.log(`Uploading release asset: ${basename(params.assetPath)}`);
      await retry(
        3,
        async () => {
          const result = await runCaptureWithCode(
            params.repoRoot,
            'gh',
            [
              'release',
              'upload',
              params.tagName,
              params.assetPath,
              '--clobber',
            ],
            { env: ghEnv },
          );
          if (result.code !== 0) {
            throw new Error(
              `gh release upload failed (${String(result.code)}): ${result.stderr || result.stdout}`,
            );
          }
        },
        (attempt, error) => {
          console.warn(
            `GitHub asset upload failed (attempt ${attempt}/3): ${formatError(
              error,
            )}`,
          );
          console.warn(
            `Tip: you can re-run later with --skip-github-create to only upload the VSIX.`,
          );
        },
      );
    }

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

  let uploadUrlTemplate: string | null = null;

  if (!params.skipCreate) {
    const release = await createOrGetGitHubRelease({
      repoSlug,
      token,
      tagName: params.tagName,
      title: params.title,
      body: params.notes,
      targetCommitish: params.targetCommitish,
      draft: params.draft,
    });
    uploadUrlTemplate = release.upload_url;
  }

  if (!params.skipUpload) {
    if (!uploadUrlTemplate) {
      const release = await getGitHubReleaseByTag({
        repoSlug,
        token,
        tagName: params.tagName,
      });
      uploadUrlTemplate = release.upload_url;
    }

    if (!uploadUrlTemplate) {
      throw new Error('Missing GitHub release upload URL.');
    }
    const uploadUrl = uploadUrlTemplate;

    await retry(
      3,
      async () => {
        await uploadGitHubReleaseAsset({
          uploadUrlTemplate: uploadUrl,
          token,
          assetPath: params.assetPath,
        });
      },
      (attempt, error) => {
        console.warn(
          `GitHub asset upload failed (attempt ${attempt}/3): ${formatError(
            error,
          )}`,
        );
        console.warn(
          `Tip: you can re-run later with --skip-github-create to only upload the VSIX.`,
        );
      },
    );
  }
}

async function ghReleaseExists(
  repoRoot: string,
  tagName: string,
): Promise<boolean> {
  try {
    await runCapture(
      repoRoot,
      'gh',
      ['release', 'view', tagName, '--json', 'url'],
      {
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      },
    );
    return true;
  } catch {
    return false;
  }
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
    const origin = (
      await runCapture(repoRoot, 'git', ['remote', 'get-url', 'origin'])
    ).stdout.trim();
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

  const https = /^https?:\/\/github\.com\/([^/]+)\/(.+)$/.exec(
    trimmed.replace(/^git\+/, ''),
  );
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
    throw new Error(
      `GitHub release create failed (${response.status}): ${message}`,
    );
  }

  const json: unknown = await response.json();
  if (!isRecord(json) || typeof json.upload_url !== 'string') {
    throw new Error('Unexpected GitHub release response.');
  }
  return { upload_url: json.upload_url };
}

async function createOrGetGitHubRelease(params: {
  repoSlug: string;
  token: string;
  tagName: string;
  title: string;
  body: string;
  targetCommitish: string;
  draft: boolean;
}): Promise<{ upload_url: string }> {
  try {
    return await createGitHubRelease(params);
  } catch (error) {
    const message = String(error);
    if (message.includes('GitHub release create failed (422)')) {
      return await getGitHubReleaseByTag({
        repoSlug: params.repoSlug,
        token: params.token,
        tagName: params.tagName,
      });
    }
    throw error;
  }
}

async function getGitHubReleaseByTag(params: {
  repoSlug: string;
  token: string;
  tagName: string;
}): Promise<{ upload_url: string }> {
  const url = `https://api.github.com/repos/${params.repoSlug}/releases/tags/${params.tagName}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vscode-unify-chat-provider-release-script',
    },
  });

  if (!response.ok) {
    const text = await safeReadResponseText(response);
    throw new Error(
      `GitHub release lookup failed (${response.status}): ${text}`,
    );
  }

  const json: unknown = await response.json();
  if (!isRecord(json) || typeof json.upload_url !== 'string') {
    throw new Error('Unexpected GitHub release lookup response.');
  }
  return { upload_url: json.upload_url };
}

async function retry(
  maxAttempts: number,
  fn: () => Promise<void>,
  onError?: (attempt: number, error: unknown) => void,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      onError?.(attempt, error);
      if (attempt >= maxAttempts) {
        throw error;
      }
      await sleep(1000 * attempt);
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
    throw new Error(
      `GitHub asset upload failed (${response.status}): ${message}`,
    );
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
  return changelogEntry.replace(
    /^(## v[\d.]+) - (\d{4}-\d{2}-\d{2})/,
    '$1 ($2)',
  );
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

async function canRun(
  cwd: string,
  command: string,
  args: string[],
): Promise<boolean> {
  try {
    await runCapture(cwd, command, args);
    return true;
  } catch {
    return false;
  }
}

type RunResult = { stdout: string; stderr: string };
type RunResultWithCode = { code: number | null; stdout: string; stderr: string };

async function runCapture(
  cwd: string,
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  const result = await runCaptureWithCode(cwd, command, args, options);
  if (result.code === 0) {
    return { stdout: result.stdout, stderr: result.stderr };
  }
  throw new Error(
    `${command} ${args.join(' ')} failed (${String(result.code)}): ${
      result.stderr || result.stdout
    }`,
  );
}

async function runCaptureWithCode(
  cwd: string,
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): Promise<RunResultWithCode> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options?.env ?? process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function runInheritCaptureWithCode(
  cwd: string,
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): Promise<RunResultWithCode> {
  return new Promise((resolve, reject) => {
    const wasPaused =
      process.stdin.isTTY && typeof process.stdin.isPaused === 'function'
        ? process.stdin.isPaused()
        : false;
    if (process.stdin.isTTY && !wasPaused) {
      process.stdin.pause();
    }

    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options?.env ?? process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on('error', (error) => {
      if (process.stdin.isTTY && !wasPaused) {
        process.stdin.resume();
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (process.stdin.isTTY && !wasPaused) {
        process.stdin.resume();
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function runInherit(
  cwd: string,
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const wasPaused =
      process.stdin.isTTY && typeof process.stdin.isPaused === 'function'
        ? process.stdin.isPaused()
        : false;
    if (process.stdin.isTTY && !wasPaused) {
      process.stdin.pause();
    }

    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: options?.env ?? process.env,
    });
    child.on('error', (error) => {
      if (process.stdin.isTTY && !wasPaused) {
        process.stdin.resume();
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (process.stdin.isTTY && !wasPaused) {
        process.stdin.resume();
      }
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

function parseJsonObject(
  text: string,
  sourcePath: string,
): Record<string, unknown> {
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
