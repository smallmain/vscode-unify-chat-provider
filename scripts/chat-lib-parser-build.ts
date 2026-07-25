import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, type Plugin } from 'esbuild';
import ts from 'typescript';
import { patchChatLibParserSource } from './chat-lib-parser-patches';

const parserEntry = join(process.cwd(), 'scripts/chat-lib-parser-entry.ts');

export function verifyChatLibParserClosure(): void {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    noImplicitReturns: true,
    noUnusedLocals: true,
    noUnusedParameters: false,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ['node'],
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (filePath, languageVersion) => {
    const source = ts.sys.readFile(filePath);
    if (source === undefined) {
      return undefined;
    }
    return ts.createSourceFile(
      filePath,
      patchChatLibParserSource(filePath, source),
      languageVersion,
      true,
    );
  };
  const program = ts.createProgram([parserEntry], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length === 0) {
    return;
  }
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: process.cwd,
      getNewLine: () => '\n',
    }),
  );
}

const strictSourcePlugin: Plugin = {
  name: 'strict-chat-lib-parser-source',
  setup(buildContext) {
    buildContext.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => ({
      contents: patchChatLibParserSource(path, await readFile(path, 'utf8')),
      loader: path.endsWith('x') ? 'tsx' : 'ts',
    }));
  },
};

export async function buildChatLibParserBundle(outputFile: string): Promise<void> {
  verifyChatLibParserClosure();
  await build({
    entryPoints: [parserEntry],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [strictSourcePlugin],
  });
}
