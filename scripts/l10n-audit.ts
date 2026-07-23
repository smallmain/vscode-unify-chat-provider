import { parseArgs } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

type Bundle = Record<string, string>;

type Location = {
  file: string;
  line: number;
  col: number;
};

type Finding = Location & {
  text: string;
};

type Options = {
  write: boolean;
  writeLocales: boolean;
  strict: boolean;
  locales?: Set<string>;
};

const ENGLISH_ONLY_EXACT_KEYS = [
  'Simple',
  'Copilot (Replica)',
] as const;
const ENGLISH_ONLY_EMBEDDED_TERMS = [
  'Simple',
  'Copilot Replica',
] as const;

const { values } = parseArgs({
  options: {
    write: { type: 'boolean' },
    'write-locales': { type: 'boolean' },
    strict: { type: 'boolean' },
    locales: { type: 'string' },
  },
});

const options: Options = {
  write: values.write === true,
  writeLocales: values['write-locales'] === true,
  strict: values.strict === true,
  locales:
    typeof values.locales === 'string'
      ? new Set(
          values.locales
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
        )
      : undefined,
};

function getLocation(sf: ts.SourceFile, node: ts.Node): Location {
  const pos = node.getStart(sf);
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return {
    file: sf.fileName,
    line: line + 1,
    col: character + 1,
  };
}

function isPropertyAccessChain(
  node: ts.Expression,
  chain: readonly string[],
): boolean {
  let current: ts.Expression = node;
  for (let i = chain.length - 1; i >= 0; i--) {
    const expected = chain[i];

    if (ts.isPropertyAccessExpression(current)) {
      if (current.name.escapedText !== expected) return false;
      current = current.expression;
      continue;
    }

    if (ts.isIdentifier(current)) {
      return i === 0 && current.escapedText === expected;
    }

    return false;
  }

  return true;
}

function isCallToT(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.escapedText === 't'
  );
}

function isStringKey(node: ts.Expression): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function stringLiteralText(node: ts.Expression): string | undefined {
  const normalized = unwrapExpression(node);
  if (ts.isStringLiteral(normalized) || ts.isNoSubstitutionTemplateLiteral(normalized)) {
    return normalized.text;
  }
  return undefined;
}

function getObjectStringProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): string | undefined {
  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propertyNameText(prop.name);
    if (name !== propertyName) continue;
    return stringLiteralText(prop.initializer);
  }
  return undefined;
}

function findVariableInitializer(
  sourceFile: ts.SourceFile,
  variableName: string,
): ts.Expression | undefined {
  let initializer: ts.Expression | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      initializer = unwrapExpression(node.initializer);
      return;
    }
    if (!initializer) {
      ts.forEachChild(node, visit);
    }
  }

  visit(sourceFile);
  return initializer;
}

function collectKnownDynamicLocalizationKeys(
  repoRoot: string,
  program: ts.Program,
): Set<string> {
  const keys = new Set<string>();

  const tokenizersSource = program.getSourceFile(
    join(repoRoot, 'src', 'tokenizer', 'tokenizers.ts'),
  );
  if (tokenizersSource) {
    const tokenizersInit = findVariableInitializer(tokenizersSource, 'TOKENIZERS');
    if (tokenizersInit && ts.isObjectLiteralExpression(tokenizersInit)) {
      for (const prop of tokenizersInit.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const entry = unwrapExpression(prop.initializer);
        if (!ts.isObjectLiteralExpression(entry)) continue;

        const label = getObjectStringProperty(entry, 'label');
        const description = getObjectStringProperty(entry, 'description');
        if (label) keys.add(label);
        if (description) keys.add(description);
      }
    }
  }

  const providerDefinitionsSource = program.getSourceFile(
    join(repoRoot, 'src', 'client', 'definitions.ts'),
  );
  if (providerDefinitionsSource) {
    const providerTypesInit = findVariableInitializer(
      providerDefinitionsSource,
      'PROVIDER_TYPES',
    );
    if (providerTypesInit && ts.isObjectLiteralExpression(providerTypesInit)) {
      for (const prop of providerTypesInit.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const entry = unwrapExpression(prop.initializer);
        if (!ts.isObjectLiteralExpression(entry)) continue;
        const category = getObjectStringProperty(entry, 'category');
        if (category) keys.add(category);
      }
    }
  }

  const authDefinitionsSource = program.getSourceFile(
    join(repoRoot, 'src', 'auth', 'definitions.ts'),
  );
  if (authDefinitionsSource) {
    const authMethodsInit = findVariableInitializer(authDefinitionsSource, 'AUTH_METHODS');
    if (authMethodsInit && ts.isObjectLiteralExpression(authMethodsInit)) {
      for (const prop of authMethodsInit.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const entry = unwrapExpression(prop.initializer);
        if (!ts.isObjectLiteralExpression(entry)) continue;
        const category = getObjectStringProperty(entry, 'category');
        if (category) keys.add(category);
      }
    }
  }

  const wellKnownProvidersSource = program.getSourceFile(
    join(repoRoot, 'src', 'well-known', 'providers.ts'),
  );
  if (wellKnownProvidersSource) {
    const providersInit = findVariableInitializer(
      wellKnownProvidersSource,
      'WELL_KNOWN_PROVIDERS',
    );
    if (providersInit && ts.isArrayLiteralExpression(providersInit)) {
      for (const element of providersInit.elements) {
        const entry = unwrapExpression(element);
        if (!ts.isObjectLiteralExpression(entry)) continue;

        const category = getObjectStringProperty(entry, 'category');
        const name = getObjectStringProperty(entry, 'name');
        if (category) keys.add(category);
        if (name) keys.add(name);
      }
    }
  }

  return keys;
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function createProgramFromTsconfig(repoRoot: string): ts.Program {
  const tsconfigPath = join(repoRoot, 'tsconfig.json');
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    const formatted = ts.formatDiagnosticsWithColorAndContext([configFile.error], {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => repoRoot,
      getNewLine: () => '\n',
    });
    throw new Error(formatted);
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  if (parsed.errors.length) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => repoRoot,
      getNewLine: () => '\n',
    });
    throw new Error(formatted);
  }

  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function collectLocalizationKeys(repoRoot: string, program: ts.Program): {
  keys: Set<string>;
  nonLiteralTCalls: Location[];
} {
  const keys = new Set<string>();
  const nonLiteralTCalls: Location[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!sf.fileName.includes(join(repoRoot, 'src'))) continue;

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;

        const isTCall =
          (ts.isIdentifier(expr) && expr.escapedText === 't') ||
          isPropertyAccessChain(expr, ['vscode', 'l10n', 't']);

        if (isTCall) {
          const arg0 = node.arguments[0];
          if (arg0 && isStringKey(arg0)) {
            keys.add(arg0.text);
          } else {
            nonLiteralTCalls.push(getLocation(sf, node));
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sf);
  }

  return { keys, nonLiteralTCalls };
}

function findNonLocalizedShowMessageCalls(
  repoRoot: string,
  program: ts.Program,
): Finding[] {
  const targets: ReadonlyArray<readonly string[]> = [
    ['vscode', 'window', 'showErrorMessage'],
    ['vscode', 'window', 'showInformationMessage'],
    ['vscode', 'window', 'showWarningMessage'],
  ];

  const findings: Finding[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!sf.fileName.includes(join(repoRoot, 'src'))) continue;

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        const arg0 = node.arguments[0];

        if (arg0) {
          for (const chain of targets) {
            if (!isPropertyAccessChain(expr, chain)) continue;
            if (isCallToT(arg0)) break;

            if (
              ts.isStringLiteral(arg0) ||
              ts.isNoSubstitutionTemplateLiteral(arg0) ||
              ts.isTemplateExpression(arg0)
            ) {
              const loc = getLocation(sf, arg0);
              findings.push({
                ...loc,
                text: arg0.getText(sf),
              });
            }
            break;
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sf);
  }

  return findings;
}

function diffKeys(a: Set<string>, b: Set<string>): {
  missing: string[];
  extra: string[];
} {
  const missing = Array.from(a).filter((k) => !b.has(k)).sort();
  const extra = Array.from(b).filter((k) => !a.has(k)).sort();
  return { missing, extra };
}

function findEnglishOnlyNameViolations(
  baseBundle: Bundle,
  localeBundle: Bundle,
): string[] {
  const violations = new Set<string>();
  for (const key of ENGLISH_ONLY_EXACT_KEYS) {
    if (localeBundle[key] !== baseBundle[key]) {
      violations.add(key);
    }
  }
  for (const [key, value] of Object.entries(localeBundle)) {
    for (const term of ENGLISH_ONLY_EMBEDDED_TERMS) {
      if (key.includes(term) && !value.includes(term)) {
        violations.add(key);
      }
    }
  }
  return [...violations].sort();
}

async function discoverLocaleBundles(repoRoot: string, baseName: string): Promise<string[]> {
  const l10nDir = join(repoRoot, 'l10n');
  if (!existsSync(l10nDir)) return [];

  const files = await readdir(l10nDir);
  const locales = files
    .filter(
      (f) =>
        f.startsWith(baseName + '.') &&
        f.endsWith('.json') &&
        f !== baseName + '.json',
    )
    .map((f) => join(l10nDir, f));

  if (!options.locales) return locales;

  return locales.filter((filePath) => {
    const file = filePath.split('/').at(-1) ?? filePath;
    const m = file.match(new RegExp(`^${baseName}\\.(.+?)\\.json$`));
    if (!m) return false;
    return options.locales!.has(m[1]);
  });
}

async function auditBundles(repoRoot: string): Promise<number> {
  const program = createProgramFromTsconfig(repoRoot);

  const { keys: literalCodeKeys, nonLiteralTCalls } = collectLocalizationKeys(
    repoRoot,
    program,
  );
  const dynamicCodeKeys = collectKnownDynamicLocalizationKeys(repoRoot, program);
  const codeKeys = new Set<string>([...literalCodeKeys, ...dynamicCodeKeys]);

  const nonLocalizedMessages = findNonLocalizedShowMessageCalls(repoRoot, program);

  const baseBundlePath = join(repoRoot, 'l10n', 'bundle.l10n.json');
  if (!existsSync(baseBundlePath)) {
    console.error('Missing base bundle:', relative(repoRoot, baseBundlePath));
    return 2;
  }

  const baseBundle = await readJson<Bundle>(baseBundlePath);
  const baseKeys = new Set(Object.keys(baseBundle));

  const missingInBase = Array.from(codeKeys).filter((k) => !baseKeys.has(k)).sort();
  if (options.write && missingInBase.length) {
    for (const k of missingInBase) {
      baseBundle[k] = k;
    }
    await writeJson(baseBundlePath, baseBundle);
  }

  const baseBundleAfter = await readJson<Bundle>(baseBundlePath);
  const baseKeysAfter = new Set(Object.keys(baseBundleAfter));

  const baseDiff = diffKeys(codeKeys, baseKeysAfter);

  console.log('[l10n] literal t() keys in code:', literalCodeKeys.size);
  console.log('[l10n] dynamic keys in code:', dynamicCodeKeys.size);
  console.log('[l10n] total keys in code:', codeKeys.size);
  console.log('[l10n] keys in base bundle:', baseKeysAfter.size);
  console.log('[l10n] missing in base bundle:', baseDiff.missing.length);
  if (baseDiff.missing.length) {
    console.log('--- missing keys (base) ---');
    console.log(baseDiff.missing.join('\n'));
  }

  console.log('[l10n] extra in base bundle:', baseDiff.extra.length);
  if (baseDiff.extra.length) {
    console.log('--- extra keys (base) ---');
    console.log(baseDiff.extra.join('\n'));
  }

  if (nonLiteralTCalls.length) {
    console.log('[l10n] non-literal t() calls (not extractable):', nonLiteralTCalls.length);
    for (const loc of nonLiteralTCalls.slice(0, 50)) {
      console.log(`- ${relative(repoRoot, loc.file)}:${loc.line}:${loc.col}`);
    }
    if (nonLiteralTCalls.length > 50) {
      console.log(`... (${nonLiteralTCalls.length - 50} more)`);
    }
  }

  if (nonLocalizedMessages.length) {
    console.log(
      '[l10n] show*Message calls with raw string/template (not wrapped in t()):',
      nonLocalizedMessages.length,
    );
    for (const f of nonLocalizedMessages.slice(0, 50)) {
      console.log(`- ${relative(repoRoot, f.file)}:${f.line}:${f.col}  ${f.text}`);
    }
    if (nonLocalizedMessages.length > 50) {
      console.log(`... (${nonLocalizedMessages.length - 50} more)`);
    }
  }

  const localePaths = await discoverLocaleBundles(repoRoot, 'bundle.l10n');
  let localeMissingTotal = 0;
  let localeExtraTotal = 0;
  let localeEnglishOnlyViolationTotal = 0;

  for (const localePath of localePaths) {
    const localeBundle = await readJson<Bundle>(localePath);
    const localeKeys = new Set(Object.keys(localeBundle));

    const missing = Array.from(baseKeysAfter)
      .filter((k) => !localeKeys.has(k))
      .sort();

    if (options.writeLocales && missing.length) {
      for (const k of missing) {
        localeBundle[k] = baseBundleAfter[k] ?? k;
      }
      await writeJson(localePath, localeBundle);
    }

    const localeBundleAfter = options.writeLocales
      ? await readJson<Bundle>(localePath)
      : localeBundle;
    const localeKeysAfter = new Set(Object.keys(localeBundleAfter));

    const extra = Array.from(localeKeysAfter)
      .filter((k) => !baseKeysAfter.has(k))
      .sort();

    const missingAfter = Array.from(baseKeysAfter)
      .filter((k) => !localeKeysAfter.has(k))
      .sort();
    const englishOnlyViolations = findEnglishOnlyNameViolations(
      baseBundleAfter,
      localeBundleAfter,
    );

    localeMissingTotal += missingAfter.length;
    localeExtraTotal += extra.length;
    localeEnglishOnlyViolationTotal += englishOnlyViolations.length;

    const localeName = relative(repoRoot, localePath);
    console.log(`[l10n] ${localeName}: missing=${missingAfter.length} extra=${extra.length}`);

    if (missingAfter.length) {
      console.log(`--- missing keys (${localeName}) ---`);
      console.log(missingAfter.join('\n'));
    }

    if (extra.length) {
      console.log(`--- extra keys (${localeName}) ---`);
      console.log(extra.join('\n'));
    }
    if (englishOnlyViolations.length) {
      console.log(`--- translated English-only names (${localeName}) ---`);
      console.log(englishOnlyViolations.join('\n'));
    }
  }

  const packageBase = join(repoRoot, 'package.nls.json');
  if (existsSync(packageBase)) {
    const pkgBase = await readJson<Record<string, string>>(packageBase);
    const pkgBaseKeys = new Set(Object.keys(pkgBase));

    const variants = (await readdir(repoRoot))
      .filter((f) => f.startsWith('package.nls.') && f.endsWith('.json'))
      .map((f) => join(repoRoot, f))
      .filter((fp) => fp !== packageBase);

    for (const variant of variants) {
      const locale = await readJson<Record<string, string>>(variant);
      const localeKeys = new Set(Object.keys(locale));
      const missing = Array.from(pkgBaseKeys)
        .filter((k) => !localeKeys.has(k))
        .sort();
      const extra = Array.from(localeKeys)
        .filter((k) => !pkgBaseKeys.has(k))
        .sort();

      console.log(
        `[package.nls] ${relative(repoRoot, variant)}: missing=${missing.length} extra=${extra.length}`,
      );

      if (missing.length) {
        console.log(`--- missing keys (${relative(repoRoot, variant)}) ---`);
        console.log(missing.join('\n'));
      }
      if (extra.length) {
        console.log(`--- extra keys (${relative(repoRoot, variant)}) ---`);
        console.log(extra.join('\n'));
      }
    }
  }

  const hasBaseMissing = baseDiff.missing.length > 0;
  const hasLocaleMissing = localeMissingTotal > 0;
  const hasShowMessageIssues = nonLocalizedMessages.length > 0;
  const hasEnglishOnlyNameViolations =
    localeEnglishOnlyViolationTotal > 0;

  const shouldFail =
    hasBaseMissing ||
    hasLocaleMissing ||
    hasShowMessageIssues ||
    hasEnglishOnlyNameViolations ||
    (options.strict &&
      (baseDiff.extra.length > 0 ||
        localeExtraTotal > 0 ||
        nonLiteralTCalls.length > 0));

  return shouldFail ? 1 : 0;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  try {
    const exitCode = await auditBundles(repoRoot);
    process.exit(exitCode);
  } catch (err) {
    console.error('[l10n] Failed:', err);
    process.exit(2);
  }
}

main();
