import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const workspaceRoot = process.cwd();

async function main(): Promise<void> {
  await Promise.all(
    ['out', 'out-test', 'dist'].map((directory) =>
      rm(join(workspaceRoot, directory), { recursive: true, force: true }),
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
