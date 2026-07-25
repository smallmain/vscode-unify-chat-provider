import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { buildChatLibDiffBundle } from './chat-lib-diff-build';
import { buildChatLibParserBundle } from './chat-lib-parser-build';
import { CHAT_LIB_TREE_SITTER_WASM_FILES } from './chat-lib-extract-utils';

const require = createRequire(__filename);
const packageRoot = dirname(
  require.resolve('@vscode/tree-sitter-wasm/package.json'),
);
const outputRoot = join(process.cwd(), 'dist');

const parserSmokeCases = [
  {
    languageId: 'javascript',
    prefix: 'function complete() {\n',
    completion: '  return 1;\n}\n',
    parseSupported: true,
  },
  {
    languageId: 'typescript',
    prefix: 'function complete(): number {\n',
    completion: '  return 1;\n}\n',
    parseSupported: true,
  },
  {
    languageId: 'typescriptreact',
    prefix: 'function Component() {\n',
    completion: '  return <div />;\n}\n',
    parseSupported: true,
  },
  {
    languageId: 'python',
    prefix: 'def complete():\n',
    completion: '    return 1\n',
    parseSupported: true,
  },
  {
    languageId: 'go',
    prefix: 'func complete() {\n',
    completion: '\treturn\n}\n',
    parseSupported: true,
  },
  {
    languageId: 'ruby',
    prefix: 'def complete\n',
    completion: '  1\nend\n',
    parseSupported: true,
  },
  {
    languageId: 'csharp',
    prefix: 'class C { void Complete() {\n',
    completion: '  return;\n} }\n',
    parseSupported: false,
  },
  {
    languageId: 'java',
    prefix: 'class C { void complete() {\n',
    completion: '  return;\n} }\n',
    parseSupported: false,
  },
  {
    languageId: 'php',
    prefix: '<?php\nfunction complete() {\n',
    completion: '  return 1;\n}\n',
    parseSupported: false,
  },
  {
    languageId: 'cpp',
    prefix: 'void complete() {\n',
    completion: '  return;\n}\n',
    parseSupported: false,
  },
] as const;

interface PackagedParserRuntime {
  isSupportedLanguageId(languageId: string): boolean;
  isBlockTrimmerSupported(languageId: string): boolean;
  blockPositionTypeAt(
    languageId: string,
    text: string,
    offset: number,
  ): Promise<string>;
  isEmptyBlockStart(
    languageId: string,
    text: string,
    offset: number,
  ): Promise<boolean>;
  isBlockBodyFinished(
    languageId: string,
    prefix: string,
    completion: string,
    offset: number,
  ): Promise<number | undefined>;
  trimWithTerseBlockTrimmer(
    languageId: string,
    prefix: string,
    completion: string,
    lineLimit?: number,
    lookAhead?: number,
  ): Promise<number | undefined>;
}

interface PackagedDetailedDiffChange {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
}

interface PackagedDiffRuntime {
  computeDetailedChanges(
    original: string,
    modified: string,
  ): readonly PackagedDetailedDiffChange[] | undefined;
  computePreciseChanges(
    original: string,
    modified: string,
  ): readonly PackagedDetailedDiffChange[] | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPackagedParserRuntime(
  value: unknown,
): value is PackagedParserRuntime {
  return (
    isRecord(value) &&
    typeof value.isSupportedLanguageId === 'function' &&
    typeof value.isBlockTrimmerSupported === 'function' &&
    typeof value.blockPositionTypeAt === 'function' &&
    typeof value.isEmptyBlockStart === 'function' &&
    typeof value.isBlockBodyFinished === 'function' &&
    typeof value.trimWithTerseBlockTrimmer === 'function'
  );
}

function isPackagedDiffRuntime(value: unknown): value is PackagedDiffRuntime {
  return (
    isRecord(value) &&
    typeof value.computeDetailedChanges === 'function' &&
    typeof value.computePreciseChanges === 'function'
  );
}

function isPackagedDetailedDiffChange(
  value: unknown,
): value is PackagedDetailedDiffChange {
  return (
    isRecord(value) &&
    typeof value.startOffset === 'number' &&
    typeof value.endOffset === 'number' &&
    Number.isInteger(value.startOffset) &&
    Number.isInteger(value.endOffset) &&
    typeof value.newText === 'string'
  );
}

async function verifyPackagedParserRuntime(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'ucp-chat-lib-parser-'),
  );
  try {
    const temporaryDist = join(temporaryRoot, 'dist');
    await mkdir(temporaryDist, { recursive: true });
    await Promise.all(
      ['chat-lib-parser.cjs', ...CHAT_LIB_TREE_SITTER_WASM_FILES].map((resource) =>
        copyFile(join(outputRoot, resource), join(temporaryDist, resource)),
      ),
    );
    const isolatedRequire = createRequire(join(temporaryRoot, 'loader.cjs'));
    const loaded: unknown = isolatedRequire(
      join(temporaryDist, 'chat-lib-parser.cjs'),
    );
    if (!isPackagedParserRuntime(loaded)) {
      throw new Error('Packaged GhostText parser runtime has invalid exports.');
    }
    const source = 'function complete() {\n  ';
    const blockPositionSource = 'function complete() {\n  \n}';
    const blockPosition = await loaded.blockPositionTypeAt(
      'typescript',
      blockPositionSource,
      blockPositionSource.indexOf('\n}'),
    );
    if (blockPosition !== 'empty-block') {
      throw new Error(
        'Packaged GhostText parser runtime failed its block-position check.',
      );
    }
    if (!(await loaded.isEmptyBlockStart('typescript', source, source.length))) {
      throw new Error(
        'Packaged GhostText parser runtime failed its isolated parse check.',
      );
    }
    const blockPrefix = 'if (ready) {\n  ';
    const blockCompletion = 'doWork();\n}\nnextStatement();';
    const blockEnd = await loaded.isBlockBodyFinished(
      'typescript',
      blockPrefix,
      blockCompletion,
      blockPrefix.length,
    );
    if (
      blockEnd !== 11 ||
      blockCompletion.slice(0, blockEnd) !== 'doWork();\n}'
    ) {
      throw new Error(
        'Packaged GhostText parser runtime failed its block-finished check.',
      );
    }
    for (const smokeCase of parserSmokeCases) {
      if (
        loaded.isSupportedLanguageId(smokeCase.languageId) !==
          smokeCase.parseSupported ||
        !loaded.isBlockTrimmerSupported(smokeCase.languageId)
      ) {
        throw new Error(
          `Packaged GhostText parser support flags differ for ${smokeCase.languageId}.`,
        );
      }
      await loaded.trimWithTerseBlockTrimmer(
        smokeCase.languageId,
        smokeCase.prefix,
        smokeCase.completion,
      );
      if (smokeCase.parseSupported) {
        const finished = await loaded.isBlockBodyFinished(
          smokeCase.languageId,
          smokeCase.prefix,
          smokeCase.completion,
          smokeCase.prefix.length,
        );
        if (finished !== undefined && !Number.isInteger(finished)) {
          throw new Error(
            `Packaged GhostText block parser returned an invalid offset for ${smokeCase.languageId}.`,
          );
        }
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyPackagedDiffRuntime(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ucp-chat-lib-diff-'));
  try {
    const temporaryDist = join(temporaryRoot, 'dist');
    await mkdir(temporaryDist, { recursive: true });
    await copyFile(
      join(outputRoot, 'chat-lib-diff.cjs'),
      join(temporaryDist, 'chat-lib-diff.cjs'),
    );
    const isolatedRequire = createRequire(join(temporaryRoot, 'loader.cjs'));
    const loaded: unknown = isolatedRequire(
      join(temporaryDist, 'chat-lib-diff.cjs'),
    );
    if (!isPackagedDiffRuntime(loaded)) {
      throw new Error('Packaged NES diff runtime has invalid exports.');
    }
    const detailed = loaded.computeDetailedChanges(
      'const value = 1;\r\nmiddle\r\nthree',
      'const value = 2;\r\nmiddle\r\nTHREE',
    );
    if (
      !Array.isArray(detailed) ||
      detailed.length !== 2 ||
      !detailed.every(isPackagedDetailedDiffChange) ||
      detailed[0]?.startOffset !== 14 ||
      detailed[0]?.endOffset !== 15 ||
      detailed[0]?.newText !== '2' ||
      detailed[1]?.startOffset !== 26 ||
      detailed[1]?.endOffset !== 31 ||
      detailed[1]?.newText !== 'THREE'
    ) {
      throw new Error(
        'Packaged NES diff runtime failed its isolated detailed-diff check.',
      );
    }
    const precise = loaded.computePreciseChanges(
      'Lorem ipsum dolor',
      'LoRE ips dolor',
    );
    if (
      !Array.isArray(precise) ||
      precise.length !== 2 ||
      !precise.every(isPackagedDetailedDiffChange) ||
      precise[0]?.startOffset !== 2 ||
      precise[0]?.endOffset !== 5 ||
      precise[0]?.newText !== 'RE' ||
      precise[1]?.startOffset !== 9 ||
      precise[1]?.endOffset !== 11 ||
      precise[1]?.newText !== ''
    ) {
      throw new Error(
        'Packaged NES diff runtime failed its isolated precise-diff check.',
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    ...CHAT_LIB_TREE_SITTER_WASM_FILES.map((resource) =>
      copyFile(join(packageRoot, 'wasm', resource), join(outputRoot, resource)),
    ),
    buildChatLibDiffBundle(join(outputRoot, 'chat-lib-diff.cjs')),
    buildChatLibParserBundle(join(outputRoot, 'chat-lib-parser.cjs')),
  ]);
  await Promise.all([
    verifyPackagedDiffRuntime(),
    verifyPackagedParserRuntime(),
  ]);
}

void main();
