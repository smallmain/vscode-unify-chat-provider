import { readFile } from 'node:fs/promises';
import { build, type Plugin } from 'esbuild';
import { join } from 'node:path';
import ts from 'typescript';
import { patchChatLibDiffSource } from './chat-lib-diff-patches';

const diffEntry = join(process.cwd(), 'scripts/chat-lib-diff-entry.ts');

export function verifyChatLibDiffClosure(): void {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    noImplicitReturns: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    esModuleInterop: true,
    types: ['node'],
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (filePath, languageVersion) => {
    const source = ts.sys.readFile(filePath);
    if (source === undefined) return undefined;
    return ts.createSourceFile(
      filePath,
      patchChatLibDiffSource(filePath, source),
      languageVersion,
      true,
    );
  };
  const program = ts.createProgram([diffEntry], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) return;
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: process.cwd,
      getNewLine: () => '\n',
    }),
  );
}

const strictSourcePlugin: Plugin = {
  name: 'strict-chat-lib-diff-source',
  setup(buildContext) {
    buildContext.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => ({
      contents: patchChatLibDiffSource(path, await readFile(path, 'utf8')),
      loader: path.endsWith('x') ? 'tsx' : 'ts',
    }));
  },
};

export async function buildChatLibDiffBundle(outputFile: string): Promise<void> {
  verifyChatLibDiffClosure();
  await build({
    entryPoints: [diffEntry],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [strictSourcePlugin],
  });
}
