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
 *   node scripts/release.mts --resume-from-tag v1.2.3
 *   node scripts/release.mts --github-tag v1.2.3
 *   node scripts/release.mts --github-tag v1.2.3 --skip-github-upload
 *   node scripts/release.mts --github-tag v1.2.3 --skip-github-create --github-asset path/to/file.vsix
 *
 * Requirements:
 * - git
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
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

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

const MARKETPLACE_PUBLISH_ATTEMPTS = 8;
const GITHUB_MUTATION_ATTEMPTS = 8;
const MARKETPLACE_RECONCILIATION_ATTEMPTS = 35;
const GITHUB_RECONCILIATION_ATTEMPTS = 12;

class NonRetryableReleaseError extends Error {}

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
    'allow-dirty': { type: 'boolean' },
    version: { type: 'string' },
    bump: { type: 'string' },
    'resume-from-tag': { type: 'string' },
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
const resumeFromTagInput =
  typeof values['resume-from-tag'] === 'string'
    ? values['resume-from-tag']
    : undefined;
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
  const publisher = getRequiredString(pkgJson, 'publisher', pkgPath);
  const currentVersion = getRequiredString(pkgJson, 'version', pkgPath);

  const currentSemver = parseSemver(currentVersion);
  if (!currentSemver) {
    throw new Error(`Invalid semver in ${pkgPath}: ${currentVersion}`);
  }

  await assertGitRepo(repoRoot);

  if (resumeFromTagInput && githubTagInput) {
    throw new Error(
      'Use either --resume-from-tag or --github-tag, not both.',
    );
  }

  if (resumeFromTagInput) {
    await runFromTagMode({
      repoRoot,
      expectedExtensionName: extensionName,
      expectedPublisher: publisher,
      tagInput: resumeFromTagInput,
      assetInput: githubAssetInput,
      notesFileInput: githubNotesFileInput,
      publishMarketplace: !skipPublish,
      skipGitHubCreate,
      skipGitHubUpload,
      githubDraft,
      yes,
      dryRun,
      requireTagCheckout: true,
      mode: 'resume',
      rl,
    });
    return;
  }

  if (githubTagInput) {
    await runFromTagMode({
      repoRoot,
      expectedExtensionName: extensionName,
      expectedPublisher: publisher,
      tagInput: githubTagInput,
      assetInput: githubAssetInput,
      notesFileInput: githubNotesFileInput,
      publishMarketplace: false,
      skipGitHubCreate,
      skipGitHubUpload,
      githubDraft,
      yes,
      dryRun,
      requireTagCheckout: false,
      mode: 'github-only',
      rl,
    });
    return;
  }

  if (skipGitHubCreate && !skipGitHubUpload) {
    throw new Error(
      'Full releases cannot upload a GitHub asset while release creation is skipped.',
    );
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

  const nextSemver = parseSemver(nextVersion);
  if (!nextSemver || compareSemverPrecedence(nextSemver, currentSemver) <= 0) {
    throw new Error(
      `Full release version must be greater than package.json (${currentVersion}): ${nextVersion}`,
    );
  }

  const tagName = `v${nextVersion}`;
  const date = formatDate(new Date());

  const branch = (
    await runCapture(repoRoot, 'git', ['branch', '--show-current'])
  ).stdout.trim();
  if (!branch) {
    throw new Error('Full releases require a checked-out branch.');
  }
  const headSha = (
    await runCapture(repoRoot, 'git', ['rev-parse', 'HEAD'])
  ).stdout.trim();
  const baseTag = await getLatestGitTag(repoRoot);
  const range = baseTag ? `${baseTag}..HEAD` : 'HEAD';
  const commits = await getCommits(repoRoot, range);

  await assertFullReleaseIdentifiersAvailable({
    repoRoot,
    tagName,
    extensionId: `${publisher}.${extensionName}`,
    version: nextVersion,
    checkMarketplace: !skipPublish,
    checkGitHub: !skipGitHubCreate || !skipGitHubUpload,
  });

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
  await packageVsix({ repoRoot, vsixPath, commit: releaseSha });
  await assertVsixIdentity({
    repoRoot,
    vsixPath,
    extensionName,
    publisher,
    version: nextVersion,
  });

  await createReleaseTag(repoRoot, tagName, releaseSha);

  await pushReleaseRefsAtomically({
    repoRoot,
    branch,
    tagName,
    releaseSha,
  });

  if (!skipPublish) {
    await publishToMarketplace({
      repoRoot,
      vsixPath,
      extensionId: `${publisher}.${extensionName}`,
      version: nextVersion,
      mode: 'full',
    });
  }

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
      mode: 'full',
    });
  }

  await assertRemoteTagTarget(repoRoot, tagName, releaseSha);
  console.log(
    `Release reconciliation succeeded for ${tagName}: origin tag and requested external publications match the local release artifacts.`,
  );

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

function compareSemverPrecedence(left: Semver, right: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }

  if (left.prerelease === undefined || right.prerelease === undefined) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === undefined ? 1 : -1;
  }

  const leftIdentifiers = left.prerelease.split('.');
  const rightIdentifiers = right.prerelease.split('.');
  const length = Math.max(leftIdentifiers.length, rightIdentifiers.length);
  for (let index = 0; index < length; index++) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      if (leftIdentifier === rightIdentifier) return 0;
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
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

function printFromTagSummary(params: {
  mode: 'resume' | 'github-only';
  tagName: string;
  tagCommit: string;
  notesSource: string;
  assetPath: string;
  publishMarketplace: boolean;
  skipGitHubCreate: boolean;
  skipGitHubUpload: boolean;
  dryRun: boolean;
}): void {
  console.log('');
  console.log(
    params.mode === 'resume'
      ? 'Resume release from existing tag'
      : 'GitHub release from existing tag',
  );
  console.log('================================');
  console.log(`- Tag:       ${params.tagName}`);
  console.log(`- Commit:    ${params.tagCommit}`);
  console.log(`- Notes:     ${params.notesSource}`);
  console.log(`- Asset:     ${params.assetPath}`);
  console.log(
    `- Publish:   ${
      params.publishMarketplace ? 'VS Code Marketplace' : 'skip'
    }`,
  );
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

async function assertFullReleaseIdentifiersAvailable(params: {
  repoRoot: string;
  tagName: string;
  extensionId: string;
  version: string;
  checkMarketplace: boolean;
  checkGitHub: boolean;
}): Promise<void> {
  const localTag = await getLocalTagTarget(params.repoRoot, params.tagName);
  if (localTag) {
    throw new Error(
      `Full release tag already exists locally: ${params.tagName} -> ${localTag}`,
    );
  }

  const remoteTag = await getRemoteTagTarget(params.repoRoot, params.tagName);
  if (remoteTag) {
    throw new Error(
      `Full release tag already exists on origin: ${params.tagName} -> ${remoteTag}`,
    );
  }

  if (params.checkMarketplace) {
    const marketplaceVersion = await getMarketplaceVersionState({
      repoRoot: params.repoRoot,
      extensionId: params.extensionId,
      version: params.version,
    });
    if (marketplaceVersion.status === 'present') {
      throw new Error(
        `VS Code Marketplace already contains ${params.extensionId}@${params.version}; full releases never reuse a published version. Use --resume-from-tag only when the matching release tag already exists.`,
      );
    }
  }

  if (
    params.checkGitHub &&
    (await githubReleaseExists(params.repoRoot, params.tagName))
  ) {
    throw new Error(
      `GitHub Release already exists for ${params.tagName}; full releases never reuse an existing release. Use --resume-from-tag after verifying the tag.`,
    );
  }
}

async function getLocalTagTarget(
  repoRoot: string,
  tagName: string,
): Promise<string | null> {
  const result = await runCaptureWithCode(repoRoot, 'git', [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/tags/${tagName}^{commit}`,
  ]);
  if (result.code === 1) {
    return null;
  }
  if (result.code !== 0) {
    throw new Error(
      `Unable to resolve local tag ${tagName}: ${result.stderr || result.stdout}`,
    );
  }
  const target = result.stdout.trim();
  return target || null;
}

async function getRemoteTagTarget(
  repoRoot: string,
  tagName: string,
): Promise<string | null> {
  const directRef = `refs/tags/${tagName}`;
  const peeledRef = `${directRef}^{}`;
  const result = await runCapture(repoRoot, 'git', [
    'ls-remote',
    'origin',
    directRef,
    peeledRef,
  ]);
  const refs = parseLsRemote(result.stdout);
  return refs.get(peeledRef) ?? refs.get(directRef) ?? null;
}

async function getRemoteBranchTarget(
  repoRoot: string,
  branch: string,
): Promise<string | null> {
  const refName = `refs/heads/${branch}`;
  const result = await runCapture(repoRoot, 'git', [
    'ls-remote',
    'origin',
    refName,
  ]);
  return parseLsRemote(result.stdout).get(refName) ?? null;
}

function parseLsRemote(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf('\t');
    if (separator <= 0) {
      throw new Error(`Unexpected git ls-remote output: ${line}`);
    }
    const sha = line.slice(0, separator);
    const refName = line.slice(separator + 1);
    refs.set(refName, sha);
  }
  return refs;
}

type MarketplaceVersionState =
  | { status: 'absent' }
  | { status: 'present'; sha256: string };

async function getMarketplaceVersionState(params: {
  repoRoot: string;
  extensionId: string;
  version: string;
}): Promise<MarketplaceVersionState> {
  const result = await runCaptureWithCode(params.repoRoot, 'vsce', [
    'show',
    params.extensionId,
    '--json',
  ]);
  if (result.code !== 0) {
    const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (output.includes('not found')) {
      return { status: 'absent' };
    }
    throw new Error(
      `Unable to reconcile VS Code Marketplace metadata for ${params.extensionId}: ${result.stderr || result.stdout}`,
    );
  }

  const stdout = result.stdout.trim();
  // `vsce show --json` prints this literal for an extension that does not exist.
  if (stdout === 'undefined') {
    return { status: 'absent' };
  }
  if (!stdout) {
    throw new Error(
      `VS Code Marketplace returned empty metadata for ${params.extensionId}.`,
    );
  }

  const metadata = parseJsonObject(
    stdout,
    `VS Code Marketplace metadata for ${params.extensionId}`,
  );
  const marketplacePublisher = metadata.publisher;
  const marketplaceExtensionName = metadata.extensionName;
  if (
    !isRecord(marketplacePublisher) ||
    typeof marketplacePublisher.publisherName !== 'string' ||
    typeof marketplaceExtensionName !== 'string' ||
    `${marketplacePublisher.publisherName}.${marketplaceExtensionName}`.toLowerCase() !==
      params.extensionId.toLowerCase()
  ) {
    throw new Error(
      `VS Code Marketplace returned metadata for a different extension than ${params.extensionId}.`,
    );
  }
  const versions = metadata.versions;
  if (!Array.isArray(versions)) {
    throw new Error(
      `VS Code Marketplace metadata for ${params.extensionId} has no versions array.`,
    );
  }

  const matchingVersion = versions.find(
    (candidate) =>
      isRecord(candidate) && candidate.version === params.version,
  );
  if (!isRecord(matchingVersion)) {
    return { status: 'absent' };
  }

  const properties = matchingVersion.properties;
  if (!Array.isArray(properties)) {
    throw new Error(
      `VS Code Marketplace metadata for ${params.extensionId}@${params.version} has no properties array.`,
    );
  }
  const hashProperty = properties.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.key === 'Microsoft.VisualStudio.Services.VsixSha256',
  );
  if (!isRecord(hashProperty) || typeof hashProperty.value !== 'string') {
    throw new Error(
      `VS Code Marketplace metadata for ${params.extensionId}@${params.version} has no VSIX SHA-256.`,
    );
  }
  const sha256 = hashProperty.value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(
      `VS Code Marketplace returned an invalid VSIX SHA-256 for ${params.extensionId}@${params.version}.`,
    );
  }
  return { status: 'present', sha256 };
}

async function assertFileSha256(
  path: string,
  expectedSha256: string,
  remoteDescription: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(
      `${remoteDescription} returned an invalid SHA-256: ${expectedSha256}`,
    );
  }
  const bytes = await readFile(path);
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new NonRetryableReleaseError(
      `${remoteDescription} already exists, but its VSIX SHA-256 (${expectedSha256}) does not match ${path} (${actualSha256}). Refusing to treat this as an idempotent resume.`,
    );
  }
}

async function assertRemoteTagTarget(
  repoRoot: string,
  tagName: string,
  expectedCommit: string,
): Promise<void> {
  const remoteTag = await getRemoteTagTarget(repoRoot, tagName);
  if (remoteTag !== expectedCommit) {
    throw new Error(
      `Remote tag reconciliation failed for ${tagName}: expected=${expectedCommit}, origin=${remoteTag ?? '(missing)'}.`,
    );
  }
}

async function createReleaseTag(
  repoRoot: string,
  tagName: string,
  expectedCommit: string,
): Promise<void> {
  const existing = await getLocalTagTarget(repoRoot, tagName);
  if (existing) {
    throw new Error(
      `Refusing to reuse local tag ${tagName}: it points to ${existing}.`,
    );
  }
  await runInherit(repoRoot, 'git', [
    'tag',
    '-a',
    tagName,
    expectedCommit,
    '-m',
    tagName,
  ]);
  const actualCommit = await getLocalTagTarget(repoRoot, tagName);
  if (actualCommit !== expectedCommit) {
    throw new Error(
      `Created tag ${tagName} points to ${actualCommit ?? '(missing)'}, expected ${expectedCommit}.`,
    );
  }
}

async function assertValidTagName(
  repoRoot: string,
  tagName: string,
): Promise<void> {
  const result = await runCaptureWithCode(repoRoot, 'git', [
    'check-ref-format',
    `refs/tags/${tagName}`,
  ]);
  if (result.code !== 0) {
    throw new Error(`Invalid git tag name: ${tagName}`);
  }
}

async function packageVsix(params: {
  repoRoot: string;
  vsixPath: string;
  commit: string;
}): Promise<void> {
  const sourceDateEpoch = (
    await runCapture(params.repoRoot, 'git', [
      'show',
      '-s',
      '--format=%ct',
      params.commit,
    ])
  ).stdout.trim();
  if (!/^\d+$/.test(sourceDateEpoch)) {
    throw new Error(
      `Unable to determine SOURCE_DATE_EPOCH for ${params.commit}.`,
    );
  }
  await runInherit(
    params.repoRoot,
    'vsce',
    ['package', '--out', params.vsixPath],
    {
      env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch },
    },
  );
  const trackedStatus = (
    await runCapture(params.repoRoot, 'git', [
      'status',
      '--porcelain',
      '--untracked-files=no',
    ])
  ).stdout.trim();
  if (trackedStatus) {
    throw new Error(
      `VSIX packaging modified tracked files; refusing to publish content that is not in ${params.commit}:\n${trackedStatus}`,
    );
  }
}

async function assertVsixIdentity(params: {
  repoRoot: string;
  vsixPath: string;
  extensionName: string;
  publisher: string;
  version: string;
}): Promise<void> {
  const source = `${params.vsixPath}:extension/package.json`;
  const archive = await JSZip.loadAsync(await readFile(params.vsixPath));
  const embeddedPackage = archive.file('extension/package.json');
  if (!embeddedPackage) {
    throw new Error(`VSIX is missing ${source}.`);
  }
  const manifest = parseJsonObject(await embeddedPackage.async('string'), source);
  const extensionName = getRequiredString(manifest, 'name', source);
  const publisher = getRequiredString(manifest, 'publisher', source);
  const version = getRequiredString(manifest, 'version', source);
  if (
    extensionName !== params.extensionName ||
    publisher !== params.publisher ||
    version !== params.version
  ) {
    throw new Error(
      `VSIX identity mismatch for ${params.vsixPath}: expected ${params.publisher}.${params.extensionName}@${params.version}, found ${publisher}.${extensionName}@${version}.`,
    );
  }
}

async function pushReleaseRefsAtomically(params: {
  repoRoot: string;
  branch: string;
  tagName: string;
  releaseSha: string;
}): Promise<void> {
  console.log(
    `Atomically pushing ${params.branch} and ${params.tagName} before external publishing...`,
  );
  await runInherit(params.repoRoot, 'git', [
    'push',
    '--atomic',
    'origin',
    `HEAD:refs/heads/${params.branch}`,
    `refs/tags/${params.tagName}:refs/tags/${params.tagName}`,
  ]);

  const remoteBranch = await getRemoteBranchTarget(
    params.repoRoot,
    params.branch,
  );
  const remoteTag = await getRemoteTagTarget(params.repoRoot, params.tagName);
  if (remoteBranch !== params.releaseSha || remoteTag !== params.releaseSha) {
    throw new Error(
      `Remote ref verification failed after atomic push: branch=${remoteBranch ?? '(missing)'}, tag=${remoteTag ?? '(missing)'}, expected=${params.releaseSha}.`,
    );
  }
}

async function publishToMarketplace(params: {
  repoRoot: string;
  vsixPath: string;
  extensionId: string;
  version: string;
  mode: 'full' | 'resume';
}): Promise<void> {
  if (params.mode === 'resume') {
    const existing = await getMarketplaceVersionState({
      repoRoot: params.repoRoot,
      extensionId: params.extensionId,
      version: params.version,
    });
    if (existing.status === 'present') {
      await assertFileSha256(
        params.vsixPath,
        existing.sha256,
        `VS Code Marketplace ${params.extensionId}@${params.version}`,
      );
      console.log(
        `VS Code Marketplace already contains ${params.extensionId}@${params.version}; tag and VSIX SHA-256 reconciliation succeeded.`,
      );
      return;
    }
  }

  const args = [
    'publish',
    '--packagePath',
    params.vsixPath,
    '--allow-all-proposed-apis',
  ];

  await retry(
    MARKETPLACE_PUBLISH_ATTEMPTS,
    async () => {
      const result = await runInheritCaptureWithCode(
        params.repoRoot,
        'vsce',
        args,
      );
      if (result.code === 0) {
        return;
      }

      const output = `${result.stderr}\n${result.stdout}`;
      const state = await getMarketplaceVersionState({
        repoRoot: params.repoRoot,
        extensionId: params.extensionId,
        version: params.version,
      });
      if (state.status === 'present') {
        await assertFileSha256(
          params.vsixPath,
          state.sha256,
          `VS Code Marketplace ${params.extensionId}@${params.version}`,
        );
        console.log(
          `VS Code Marketplace accepted ${params.extensionId}@${params.version} despite an ambiguous client response; VSIX SHA-256 reconciliation succeeded.`,
        );
        return;
      }
      if (isMarketplaceAlreadyPublishedError(output)) {
        console.warn(
          `VS Code Marketplace reports ${params.extensionId}@${params.version} already exists, but its metadata is not visible yet; switching to read-only reconciliation.`,
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

  await retry(
    MARKETPLACE_RECONCILIATION_ATTEMPTS,
    async () => {
      const state = await getMarketplaceVersionState({
        repoRoot: params.repoRoot,
        extensionId: params.extensionId,
        version: params.version,
      });
      if (state.status === 'absent') {
        throw new Error(
          `VS Code Marketplace has not exposed ${params.extensionId}@${params.version} yet.`,
        );
      }
      await assertFileSha256(
        params.vsixPath,
        state.sha256,
        `VS Code Marketplace ${params.extensionId}@${params.version}`,
      );
    },
    (attempt, error) => {
      console.warn(
        `VS Code Marketplace post-publish reconciliation failed (attempt ${attempt}/${MARKETPLACE_RECONCILIATION_ATTEMPTS}): ${formatError(error)}`,
      );
    },
  );
  console.log(
    `VS Code Marketplace publication verified: ${params.extensionId}@${params.version}.`,
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

async function runFromTagMode(params: {
  repoRoot: string;
  expectedExtensionName: string;
  expectedPublisher: string;
  tagInput: string;
  assetInput: string | undefined;
  notesFileInput: string | undefined;
  publishMarketplace: boolean;
  skipGitHubCreate: boolean;
  skipGitHubUpload: boolean;
  githubDraft: boolean;
  yes: boolean;
  dryRun: boolean;
  requireTagCheckout: boolean;
  mode: 'resume' | 'github-only';
  rl: ReturnType<typeof createInterface> | null;
}): Promise<void> {
  const tagName = normalizeGitTag(params.tagInput);
  await assertValidTagName(params.repoRoot, tagName);
  const versionFromTag = tagName.startsWith('v') ? tagName.slice(1) : tagName;
  if (!parseSemver(versionFromTag)) {
    throw new Error(
      `Release tag must contain a semantic version (for example v1.2.3): ${tagName}`,
    );
  }

  const tagCommit = await getLocalTagTarget(params.repoRoot, tagName);
  if (!tagCommit) {
    throw new Error(`Git tag not found: ${tagName}`);
  }

  const remoteTagCommit = await getRemoteTagTarget(params.repoRoot, tagName);
  if (remoteTagCommit !== tagCommit) {
    throw new Error(
      `Tag reconciliation failed for ${tagName}: local=${tagCommit}, origin=${remoteTagCommit ?? '(missing)'}.`,
    );
  }

  const headCommit = (
    await runCapture(params.repoRoot, 'git', ['rev-parse', 'HEAD'])
  ).stdout.trim();
  if (params.requireTagCheckout && headCommit !== tagCommit) {
    throw new Error(
      `--resume-from-tag must run from the tagged commit: HEAD=${headCommit}, ${tagName}=${tagCommit}.`,
    );
  }

  const tagPackagePath = `${tagName}:package.json`;
  const tagPackageText = (
    await runCapture(params.repoRoot, 'git', ['show', tagPackagePath])
  ).stdout;
  const tagPackage = parseJsonObject(tagPackageText, tagPackagePath);
  const extensionName = getRequiredString(tagPackage, 'name', tagPackagePath);
  const publisher = getRequiredString(tagPackage, 'publisher', tagPackagePath);
  const packageVersion = getRequiredString(tagPackage, 'version', tagPackagePath);
  if (
    extensionName !== params.expectedExtensionName ||
    publisher !== params.expectedPublisher
  ) {
    throw new Error(
      `Tag extension identity mismatch: expected ${params.expectedPublisher}.${params.expectedExtensionName}, found ${publisher}.${extensionName}.`,
    );
  }
  if (packageVersion !== versionFromTag) {
    throw new Error(
      `Tag/package version mismatch: ${tagName} contains package version ${packageVersion}.`,
    );
  }

  const changelogSource = `${tagName}:CHANGELOG.md`;

  let notesSource = `CHANGELOG.md (${tagName})`;
  let notes: string;
  if (params.notesFileInput) {
    notesSource = params.notesFileInput;
    notes = await readTextFile(params.notesFileInput);
  } else {
    const changelogText = (
      await runCapture(params.repoRoot, 'git', ['show', changelogSource])
    ).stdout;
    const entry = extractChangelogEntryForTag(changelogText, tagName);
    if (!entry) {
      throw new Error(
        `Unable to find ${tagName} entry in ${changelogSource}. Pass --github-notes-file to provide release notes.`,
      );
    }
    notes = changelogToGitHubReleaseNotes(entry);
  }

  const defaultAssetPath = join(
    params.repoRoot,
    `${extensionName}-${versionFromTag}.vsix`,
  );
  const assetPath = params.assetInput ?? defaultAssetPath;

  printFromTagSummary({
    mode: params.mode,
    tagName,
    tagCommit,
    notesSource,
    assetPath,
    publishMarketplace: params.publishMarketplace,
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
      params.mode === 'resume'
        ? 'Continue resuming this release?'
        : 'Continue with GitHub release create/upload?',
      false,
    );
    if (!proceed) {
      console.log('Aborted.');
      return;
    }
  }

  const needsAsset = params.publishMarketplace || !params.skipGitHubUpload;
  if (needsAsset) {
    if (!(await fileExists(assetPath))) {
      if (headCommit !== tagCommit) {
        throw new Error(
          `Cannot build ${assetPath}: HEAD must be the tagged commit ${tagCommit}.`,
        );
      }
      await packageVsix({
        repoRoot: params.repoRoot,
        vsixPath: assetPath,
        commit: tagCommit,
      });
    }
    await assertVsixIdentity({
      repoRoot: params.repoRoot,
      vsixPath: assetPath,
      extensionName,
      publisher,
      version: packageVersion,
    });
  }

  if (params.publishMarketplace) {
    await publishToMarketplace({
      repoRoot: params.repoRoot,
      vsixPath: assetPath,
      extensionId: `${publisher}.${extensionName}`,
      version: packageVersion,
      mode: 'resume',
    });
  }

  if (!params.skipGitHubCreate || !params.skipGitHubUpload) {
    await publishGitHubRelease({
      repoRoot: params.repoRoot,
      tagName,
      title: tagName,
      notes,
      targetCommitish: tagCommit,
      assetPath,
      draft: params.githubDraft,
      skipCreate: params.skipGitHubCreate,
      skipUpload: params.skipGitHubUpload,
      mode: params.mode === 'resume' ? 'resume' : 'github-only',
    });
  }

  await assertRemoteTagTarget(params.repoRoot, tagName, tagCommit);
  console.log(
    `Release reconciliation succeeded for ${tagName}: origin tag and requested external publications match the local release artifacts.`,
  );
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
  mode: 'full' | 'resume' | 'github-only';
}): Promise<void> {
  if (params.skipCreate && params.skipUpload) {
    return;
  }

  const ghEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'dumb',
  };

  let existingRelease = await getGitHubReleaseMetadataOrNull(
    params.repoRoot,
    params.tagName,
  );
  if (existingRelease) {
    if (params.mode === 'full') {
      throw new Error(
        `GitHub Release already exists for ${params.tagName}; full release collisions are fatal.`,
      );
    }
    assertGitHubReleaseMatches({
      metadata: existingRelease,
      tagName: params.tagName,
      targetCommitish: params.targetCommitish,
      title: params.title,
      notes: params.notes,
      draft: params.draft,
      checkPresentation: !params.skipCreate,
    });
  } else if (params.skipCreate && !params.skipUpload) {
    throw new Error(
      `Cannot upload ${basename(params.assetPath)} because GitHub Release ${params.tagName} does not exist and creation was skipped.`,
    );
  }

  let shouldUpload = !params.skipUpload;
  if (shouldUpload && existingRelease) {
    shouldUpload = await shouldUploadGitHubAsset({
      assetPath: params.assetPath,
      release: existingRelease,
    });
  }

  if (await canRun(params.repoRoot, 'gh', ['--version'])) {
    const notesFile = await writeTempNotes(params.notes);

    if (!params.skipCreate && !existingRelease) {
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

      await retry(
        GITHUB_MUTATION_ATTEMPTS,
        async () => {
          const result = await runCaptureWithCode(params.repoRoot, 'gh', args, {
            env: ghEnv,
          });
          if (result.code === 0) {
            const output = (result.stdout || result.stderr).trimEnd();
            if (output) {
              console.log(output);
            }
            return;
          }

          existingRelease = await getMatchingGitHubReleaseOrNull({
            repoRoot: params.repoRoot,
            tagName: params.tagName,
            targetCommitish: params.targetCommitish,
            title: params.title,
            notes: params.notes,
            draft: params.draft,
            checkPresentation: true,
          });
          if (!existingRelease) {
            throw new Error(
              `gh release create failed (${String(result.code)}): ${result.stderr || result.stdout}`,
            );
          }
          if (!params.skipUpload) {
            shouldUpload = await shouldUploadGitHubAsset({
              assetPath: params.assetPath,
              release: existingRelease,
            });
          }
          console.log(
            `GitHub Release ${params.tagName} exists despite an ambiguous create response; metadata reconciliation succeeded.`,
          );
        },
        (attempt, error) => {
          console.warn(
            `GitHub Release creation failed (attempt ${attempt}/${GITHUB_MUTATION_ATTEMPTS}): ${formatError(error)}`,
          );
        },
      );
    }

    if (shouldUpload) {
      console.log(`Uploading release asset: ${basename(params.assetPath)}`);
      await retry(
        GITHUB_MUTATION_ATTEMPTS,
        async () => {
          const result = await runCaptureWithCode(
            params.repoRoot,
            'gh',
            [
              'release',
              'upload',
              params.tagName,
              params.assetPath,
            ],
            { env: ghEnv },
          );
          if (result.code !== 0) {
            const reconciled = await reconcileGitHubAssetAfterMutationError({
              repoRoot: params.repoRoot,
              tagName: params.tagName,
              targetCommitish: params.targetCommitish,
              title: params.title,
              notes: params.notes,
              draft: params.draft,
              checkPresentation: !params.skipCreate,
              assetPath: params.assetPath,
            });
            if (reconciled) {
              return;
            }
            throw new Error(
              `gh release upload failed (${String(result.code)}): ${result.stderr || result.stdout}`,
            );
          }
        },
        (attempt, error) => {
          console.warn(
            `GitHub asset upload failed (attempt ${attempt}/${GITHUB_MUTATION_ATTEMPTS}): ${formatError(
              error,
            )}`,
          );
          console.warn(
            `Tip: you can re-run later with --skip-github-create to only upload the VSIX.`,
          );
        },
      );
    }

    await reconcileGitHubPublication(params);
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

  let uploadUrlTemplate: string | null = existingRelease?.uploadUrl ?? null;

  if (!params.skipCreate && !existingRelease) {
    await retry(
      GITHUB_MUTATION_ATTEMPTS,
      async () => {
        try {
          const release = await createGitHubRelease({
            repoSlug,
            token,
            tagName: params.tagName,
            title: params.title,
            body: params.notes,
            targetCommitish: params.targetCommitish,
            draft: params.draft,
          });
          uploadUrlTemplate = release.upload_url;
        } catch (error) {
          existingRelease = await getMatchingGitHubReleaseOrNull({
            repoRoot: params.repoRoot,
            tagName: params.tagName,
            targetCommitish: params.targetCommitish,
            title: params.title,
            notes: params.notes,
            draft: params.draft,
            checkPresentation: true,
          });
          if (!existingRelease) {
            throw error;
          }
          if (!params.skipUpload) {
            shouldUpload = await shouldUploadGitHubAsset({
              assetPath: params.assetPath,
              release: existingRelease,
            });
          }
          uploadUrlTemplate = existingRelease.uploadUrl;
          console.log(
            `GitHub Release ${params.tagName} exists despite an ambiguous create response; metadata reconciliation succeeded.`,
          );
        }
      },
      (attempt, error) => {
        console.warn(
          `GitHub Release creation failed (attempt ${attempt}/${GITHUB_MUTATION_ATTEMPTS}): ${formatError(error)}`,
        );
      },
    );
  }

  if (shouldUpload) {
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
      GITHUB_MUTATION_ATTEMPTS,
      async () => {
        try {
          await uploadGitHubReleaseAsset({
            uploadUrlTemplate: uploadUrl,
            token,
            assetPath: params.assetPath,
          });
        } catch (error) {
          const reconciled = await reconcileGitHubAssetAfterMutationError({
            repoRoot: params.repoRoot,
            tagName: params.tagName,
            targetCommitish: params.targetCommitish,
            title: params.title,
            notes: params.notes,
            draft: params.draft,
            checkPresentation: !params.skipCreate,
            assetPath: params.assetPath,
          });
          if (!reconciled) {
            throw error;
          }
        }
      },
      (attempt, error) => {
        console.warn(
          `GitHub asset upload failed (attempt ${attempt}/${GITHUB_MUTATION_ATTEMPTS}): ${formatError(
            error,
          )}`,
        );
        console.warn(
          `Tip: you can re-run later with --skip-github-create to only upload the VSIX.`,
        );
      },
    );
  }

  await reconcileGitHubPublication(params);
}

type GitHubReleaseAsset = {
  name: string;
  digest: string | null;
};

type GitHubReleaseMetadata = {
  tagName: string;
  targetCommitish: string;
  title: string;
  body: string;
  draft: boolean;
  assets: GitHubReleaseAsset[];
  uploadUrl: string | null;
};

async function githubReleaseExists(
  repoRoot: string,
  tagName: string,
): Promise<boolean> {
  return (await getGitHubReleaseMetadataOrNull(repoRoot, tagName)) !== null;
}

async function getGitHubReleaseMetadataOrNull(
  repoRoot: string,
  tagName: string,
): Promise<GitHubReleaseMetadata | null> {
  if (await canRun(repoRoot, 'gh', ['--version'])) {
    const result = await runCaptureWithCode(
      repoRoot,
      'gh',
      [
        'release',
        'view',
        tagName,
        '--json',
        'name,body,tagName,targetCommitish,isDraft,assets',
      ],
      { env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' } },
    );
    if (result.code !== 0) {
      const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
      if (combined.includes('release not found')) {
        return null;
      }
      throw new Error(
        `Unable to reconcile GitHub Release ${tagName}: ${result.stderr || result.stdout}`,
      );
    }
    const json = parseJsonObject(
      result.stdout,
      `GitHub Release metadata for ${tagName}`,
    );
    return parseGitHubReleaseMetadata(json, tagName, 'gh');
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GitHub release reconciliation requires gh or GITHUB_TOKEN.',
    );
  }
  const repoSlug = await resolveGitHubRepoSlug(repoRoot);
  if (!repoSlug) {
    throw new Error('Unable to determine GitHub repository (owner/repo).');
  }
  const url = `https://api.github.com/repos/${repoSlug}/releases/tags/${tagName}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: githubApiHeaders(token),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const message = await safeReadResponseText(response);
    throw new Error(
      `GitHub release reconciliation failed (${response.status}): ${message}`,
    );
  }
  const json: unknown = await response.json();
  if (!isRecord(json)) {
    throw new Error(`Unexpected GitHub Release metadata for ${tagName}.`);
  }
  return parseGitHubReleaseMetadata(json, tagName, 'api');
}

function parseGitHubReleaseMetadata(
  json: Record<string, unknown>,
  expectedTag: string,
  source: 'gh' | 'api',
): GitHubReleaseMetadata {
  const tagName = getRequiredString(
    json,
    source === 'gh' ? 'tagName' : 'tag_name',
    `GitHub Release metadata for ${expectedTag}`,
  );
  const targetCommitish = getRequiredString(
    json,
    source === 'gh' ? 'targetCommitish' : 'target_commitish',
    `GitHub Release metadata for ${expectedTag}`,
  );
  const title = getRequiredString(
    json,
    source === 'gh' ? 'name' : 'name',
    `GitHub Release metadata for ${expectedTag}`,
  );
  const bodyValue = json.body;
  const draftValue = json[source === 'gh' ? 'isDraft' : 'draft'];
  const assetsValue = json.assets;
  if (typeof bodyValue !== 'string' || typeof draftValue !== 'boolean') {
    throw new Error(`Unexpected GitHub Release metadata for ${expectedTag}.`);
  }
  if (!Array.isArray(assetsValue)) {
    throw new Error(
      `GitHub Release metadata for ${expectedTag} has no assets array.`,
    );
  }
  const assets = assetsValue.map((asset): GitHubReleaseAsset => {
    if (!isRecord(asset) || typeof asset.name !== 'string') {
      throw new Error(
        `Unexpected GitHub Release asset metadata for ${expectedTag}.`,
      );
    }
    const digest = asset.digest;
    if (digest !== undefined && digest !== null && typeof digest !== 'string') {
      throw new Error(
        `Unexpected GitHub Release asset digest for ${expectedTag}.`,
      );
    }
    return { name: asset.name, digest: digest ?? null };
  });
  const uploadUrlValue = json.upload_url;
  const uploadUrl =
    typeof uploadUrlValue === 'string' ? uploadUrlValue : null;
  return {
    tagName,
    targetCommitish,
    title,
    body: bodyValue,
    draft: draftValue,
    assets,
    uploadUrl,
  };
}

function assertGitHubReleaseMatches(params: {
  metadata: GitHubReleaseMetadata;
  tagName: string;
  targetCommitish: string;
  title: string;
  notes: string;
  draft: boolean;
  checkPresentation: boolean;
}): void {
  if (
    params.metadata.tagName !== params.tagName ||
    params.metadata.targetCommitish !== params.targetCommitish
  ) {
    throw new Error(
      `GitHub Release ${params.tagName} does not match the release tag: tag=${params.metadata.tagName}, target=${params.metadata.targetCommitish}, expected=${params.targetCommitish}.`,
    );
  }
  if (!params.checkPresentation) {
    return;
  }
  const normalizeNotes = (value: string) =>
    value.replace(/\r\n/g, '\n').trimEnd();
  if (
    params.metadata.title !== params.title ||
    params.metadata.draft !== params.draft ||
    normalizeNotes(params.metadata.body) !== normalizeNotes(params.notes)
  ) {
    throw new Error(
      `GitHub Release ${params.tagName} already exists with different title, notes, or draft state. Refusing to treat it as an idempotent resume.`,
    );
  }
}

async function getMatchingGitHubReleaseOrNull(params: {
  repoRoot: string;
  tagName: string;
  targetCommitish: string;
  title: string;
  notes: string;
  draft: boolean;
  checkPresentation: boolean;
}): Promise<GitHubReleaseMetadata | null> {
  const metadata = await getGitHubReleaseMetadataOrNull(
    params.repoRoot,
    params.tagName,
  );
  if (!metadata) {
    return null;
  }
  assertGitHubReleaseMatches({
    metadata,
    tagName: params.tagName,
    targetCommitish: params.targetCommitish,
    title: params.title,
    notes: params.notes,
    draft: params.draft,
    checkPresentation: params.checkPresentation,
  });
  return metadata;
}

async function reconcileGitHubAssetAfterMutationError(params: {
  repoRoot: string;
  tagName: string;
  targetCommitish: string;
  title: string;
  notes: string;
  draft: boolean;
  checkPresentation: boolean;
  assetPath: string;
}): Promise<boolean> {
  const metadata = await getMatchingGitHubReleaseOrNull(params);
  if (!metadata) {
    return false;
  }
  const assetName = basename(params.assetPath);
  const asset = metadata.assets.find(
    (candidate) => candidate.name === assetName,
  );
  if (!asset) {
    return false;
  }
  await assertGitHubAssetMatches(params.assetPath, asset);
  console.log(
    `GitHub accepted ${assetName} despite an ambiguous upload response; VSIX SHA-256 reconciliation succeeded.`,
  );
  return true;
}

async function shouldUploadGitHubAsset(params: {
  assetPath: string;
  release: GitHubReleaseMetadata;
}): Promise<boolean> {
  const assetName = basename(params.assetPath);
  const existing = params.release.assets.find(
    (candidate) => candidate.name === assetName,
  );
  if (!existing) {
    return true;
  }
  await assertGitHubAssetMatches(params.assetPath, existing);
  console.log(`GitHub asset already exists and matches: ${assetName}`);
  return false;
}

async function assertGitHubAssetMatches(
  assetPath: string,
  asset: GitHubReleaseAsset,
): Promise<void> {
  const assetName = basename(assetPath);
  if (asset.name !== assetName) {
    throw new Error(
      `GitHub Release asset mismatch: expected ${assetName}, found ${asset.name}.`,
    );
  }
  if (!asset.digest?.startsWith('sha256:')) {
    throw new Error(
      `GitHub asset ${assetName} already exists without a verifiable SHA-256 digest. Refusing to overwrite it.`,
    );
  }
  await assertFileSha256(
    assetPath,
    asset.digest.slice('sha256:'.length).toLowerCase(),
    `GitHub asset ${assetName}`,
  );
}

async function reconcileGitHubPublication(params: {
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
  await retry(
    GITHUB_RECONCILIATION_ATTEMPTS,
    async () => {
      const metadata = await getGitHubReleaseMetadataOrNull(
        params.repoRoot,
        params.tagName,
      );
      if (!metadata) {
        throw new Error(
          `GitHub Release ${params.tagName} is not visible yet.`,
        );
      }
      assertGitHubReleaseMatches({
        metadata,
        tagName: params.tagName,
        targetCommitish: params.targetCommitish,
        title: params.title,
        notes: params.notes,
        draft: params.draft,
        checkPresentation: !params.skipCreate,
      });
      if (!params.skipUpload) {
        const assetName = basename(params.assetPath);
        const asset = metadata.assets.find(
          (candidate) => candidate.name === assetName,
        );
        if (!asset) {
          throw new Error(
            `GitHub Release ${params.tagName} does not expose ${assetName} yet.`,
          );
        }
        await assertGitHubAssetMatches(params.assetPath, asset);
      }
    },
    (attempt, error) => {
      console.warn(
        `GitHub Release post-publish reconciliation failed (attempt ${attempt}/${GITHUB_RECONCILIATION_ATTEMPTS}): ${formatError(error)}`,
      );
    },
  );
  console.log(`GitHub Release publication verified: ${params.tagName}.`);
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

function githubApiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vscode-unify-chat-provider-release-script',
  };
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
      if (error instanceof NonRetryableReleaseError) {
        throw error;
      }
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
