import { minimatch } from 'minimatch';

export const DEFAULT_COMPLETION_DISABLED_GLOBS = [
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/*.cert',
  '**/*.crt',
  '**/.dev.vars',
  '**/secrets.yml',
] as const;

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function mergeCompletionDisabledGlobs(
  configured: readonly string[] = [],
): string[] {
  const merged = new Set<string>(DEFAULT_COMPLETION_DISABLED_GLOBS);
  for (const pattern of configured) {
    const normalized = pattern.trim();
    if (normalized) {
      merged.add(normalized);
    }
  }
  return [...merged];
}

export function matchesCompletionDisabledGlob(
  relativePath: string,
  patterns: readonly string[],
): boolean {
  const normalizedPath = normalizePath(relativePath);
  return patterns.some((pattern) =>
    minimatch(normalizedPath, normalizePath(pattern), {
      dot: true,
      nocase: process.platform === 'win32',
    }),
  );
}
