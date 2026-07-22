import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import * as sudoPrompt from '@vscode/sudo-prompt';

const PRODUCT_FILE_NAME = 'product.json';
const BACKUP_DIRECTORY_NAME = 'proposed-api-product-backups';

export type ProductJsonErrorCode =
  | 'unsupported-web'
  | 'unsupported-remote'
  | 'unsupported-platform'
  | 'invalid-app-root'
  | 'invalid-product'
  | 'invalid-manifest'
  | 'concurrent-change'
  | 'read-only'
  | 'cancelled'
  | 'write-failed'
  | 'verification-failed';

export class ProductJsonError extends Error {
  constructor(
    readonly code: ProductJsonErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProductJsonError';
  }
}

export interface ProductJsonEnvironment {
  readonly uiKind: vscode.UIKind;
  readonly remoteName: string | undefined;
  readonly appRoot: string;
  readonly extensionId: string;
  readonly globalStoragePath: string;
  readonly platform: NodeJS.Platform;
}

export interface ProductJsonInspection {
  readonly targetPath: string;
  readonly configured: boolean;
}

export interface ProductJsonWriteResult extends ProductJsonInspection {
  readonly changed: boolean;
  readonly elevated: boolean;
  readonly backupPath?: string;
}

interface ProductDocument {
  readonly root: Record<string, unknown>;
  readonly bytes: Buffer;
  readonly hash: string;
  readonly mode: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateProposalList(proposals: readonly string[]): void {
  if (
    proposals.length === 0 ||
    proposals.some((proposal) => !isNonEmptyString(proposal)) ||
    new Set(proposals).size !== proposals.length
  ) {
    throw new ProductJsonError(
      'invalid-manifest',
      'The extension Proposed API list is empty or invalid.',
    );
  }
}

function validateProductRoot(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProductJsonError(
      'invalid-product',
      'The VS Code product.json root must be an object.',
    );
  }
  const hasProductName =
    isNonEmptyString(value['nameShort']) || isNonEmptyString(value['nameLong']);
  const hasApplicationIdentity =
    isNonEmptyString(value['applicationName']) ||
    isNonEmptyString(value['dataFolderName']);
  if (!hasProductName || !hasApplicationIdentity) {
    throw new ProductJsonError(
      'invalid-product',
      'The target does not look like a VS Code product.json file.',
    );
  }
  const configured = value['extensionEnabledApiProposals'];
  if (configured !== undefined && !isRecord(configured)) {
    throw new ProductJsonError(
      'invalid-product',
      'product.json#extensionEnabledApiProposals must be an object.',
    );
  }
  return value;
}

function parseProductBytes(bytes: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ProductJsonError(
      'invalid-product',
      'Unable to parse the VS Code product.json file.',
      { cause: error },
    );
  }
  return validateProductRoot(parsed);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function resolveTargetPath(environment: ProductJsonEnvironment): string {
  if (environment.uiKind !== vscode.UIKind.Desktop) {
    throw new ProductJsonError(
      'unsupported-web',
      'Automatic enablement is unavailable in a Web extension host.',
    );
  }
  if (environment.remoteName) {
    throw new ProductJsonError(
      'unsupported-remote',
      `Automatic enablement is unavailable in a remote extension host (${environment.remoteName}).`,
    );
  }
  if (
    environment.platform !== 'darwin' &&
    environment.platform !== 'linux' &&
    environment.platform !== 'win32'
  ) {
    throw new ProductJsonError(
      'unsupported-platform',
      `Automatic enablement is unavailable on ${environment.platform}.`,
    );
  }
  if (!isNonEmptyString(environment.appRoot)) {
    throw new ProductJsonError(
      'invalid-app-root',
      'VS Code did not provide a usable application root.',
    );
  }
  const appRoot = resolve(environment.appRoot);
  const targetPath = resolve(appRoot, PRODUCT_FILE_NAME);
  if (dirname(targetPath) !== appRoot) {
    throw new ProductJsonError(
      'invalid-app-root',
      'The resolved product.json target is outside the application root.',
    );
  }
  return targetPath;
}

export function createProductJsonEnvironment(
  context: {
    readonly extension: { readonly id: string };
    readonly globalStorageUri: { readonly fsPath: string };
  },
): ProductJsonEnvironment {
  return {
    uiKind: vscode.env.uiKind,
    remoteName: vscode.env.remoteName,
    appRoot: vscode.env.appRoot,
    extensionId: context.extension.id,
    globalStoragePath: context.globalStorageUri.fsPath,
    platform: process.platform,
  };
}

async function readProductDocument(targetPath: string): Promise<ProductDocument> {
  let bytes: Buffer;
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    [bytes, fileStat] = await Promise.all([readFile(targetPath), stat(targetPath)]);
  } catch (error) {
    throw new ProductJsonError(
      'invalid-product',
      'Unable to read the VS Code product.json file.',
      { cause: error },
    );
  }
  return {
    root: parseProductBytes(bytes),
    bytes,
    hash: hashBytes(bytes),
    mode: fileStat.mode & 0o777,
  };
}

function readProposalMap(
  root: Record<string, unknown>,
): Record<string, unknown> {
  const value = root['extensionEnabledApiProposals'];
  return value === undefined ? {} : { ...validateProposalMap(value) };
}

function validateProposalMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProductJsonError(
      'invalid-product',
      'product.json#extensionEnabledApiProposals must be an object.',
    );
  }
  return value;
}

function findExtensionProposalKeys(
  proposalMap: Record<string, unknown>,
  extensionId: string,
): string[] {
  const normalizedId = extensionId.toLowerCase();
  return Object.keys(proposalMap).filter(
    (key) => key.toLowerCase() === normalizedId,
  );
}

function isExactProposalList(
  value: unknown,
  proposals: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === proposals.length &&
    value.every((proposal, index) => proposal === proposals[index])
  );
}

export function isProductConfiguredForExtension(
  root: Record<string, unknown>,
  extensionId: string,
  proposals: readonly string[],
): boolean {
  validateProposalList(proposals);
  const proposalMap = readProposalMap(root);
  const keys = findExtensionProposalKeys(proposalMap, extensionId);
  return (
    keys.length === 1 && isExactProposalList(proposalMap[keys[0]], proposals)
  );
}

export function createUpdatedProductRoot(
  root: Record<string, unknown>,
  extensionId: string,
  proposals: readonly string[],
): Record<string, unknown> {
  validateProposalList(proposals);
  validateProductRoot(root);
  const proposalMap = readProposalMap(root);
  for (const key of findExtensionProposalKeys(proposalMap, extensionId)) {
    delete proposalMap[key];
  }
  proposalMap[extensionId] = [...proposals];
  return {
    ...root,
    extensionEnabledApiProposals: proposalMap,
  };
}

function serializeProductRoot(root: Record<string, unknown>): Buffer {
  const text = `${JSON.stringify(root, undefined, 2)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  const reparsed = parseProductBytes(bytes);
  if (JSON.stringify(reparsed) !== JSON.stringify(root)) {
    throw new ProductJsonError(
      'verification-failed',
      'The generated product.json did not pass structural verification.',
    );
  }
  return bytes;
}

async function createBackup(
  environment: ProductJsonEnvironment,
  document: ProductDocument,
): Promise<string> {
  if (!isNonEmptyString(environment.globalStoragePath)) {
    throw new ProductJsonError(
      'write-failed',
      'The extension global storage path is unavailable.',
    );
  }
  const backupDirectory = join(
    environment.globalStoragePath,
    BACKUP_DIRECTORY_NAME,
  );
  const backupPath = join(backupDirectory, `${document.hash}.product.json`);
  await mkdir(backupDirectory, { recursive: true });
  try {
    await writeFile(backupPath, document.bytes, { flag: 'wx', mode: 0o400 });
  } catch (error) {
    if (getErrorCode(error) !== 'EEXIST') {
      throw error;
    }
    const existingBackup = await readFile(backupPath);
    if (hashBytes(existingBackup) !== document.hash) {
      throw new ProductJsonError(
        'verification-failed',
        'An existing product.json backup failed integrity verification.',
      );
    }
  }
  await chmod(backupPath, 0o400);
  return backupPath;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

async function writeAtomically(
  targetPath: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const temporaryPath = join(
    dirname(targetPath),
    `.${PRODUCT_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, targetPath);
  } finally {
    await unlinkIfPresent(temporaryPath);
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function isPermissionError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'EACCES' || code === 'EPERM';
}

function isReadOnlyError(error: unknown): boolean {
  return getErrorCode(error) === 'EROFS';
}

function validateCommandPath(path: string): void {
  if (path.includes('\0') || path.includes('\n') || path.includes('\r')) {
    throw new ProductJsonError(
      'write-failed',
      'A required file path cannot be represented safely for elevation.',
    );
  }
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShellLiteral(value: string): string {
  validateCommandPath(value);
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildProductJsonElevatedCommand(
  environment: ProductJsonEnvironment,
  sourcePath: string,
  targetPath: string,
  mode: number,
  expectedHash: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new ProductJsonError(
      'write-failed',
      'The expected product.json hash is invalid.',
    );
  }
  const temporaryPath = join(
    dirname(targetPath),
    `.${PRODUCT_FILE_NAME}.${randomUUID()}.elevated.tmp`,
  );
  validateCommandPath(sourcePath);
  validateCommandPath(targetPath);
  validateCommandPath(temporaryPath);
  if (environment.platform === 'win32') {
    const source = quotePowerShellLiteral(sourcePath);
    const target = quotePowerShellLiteral(targetPath);
    const temporary = quotePowerShellLiteral(temporaryPath);
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath ${target}).Hash.ToLowerInvariant()`,
      `if ($currentHash -ne '${expectedHash}') { exit 73 }`,
      `try { Copy-Item -LiteralPath ${source} -Destination ${temporary} -Force; [System.IO.File]::Replace(${temporary}, ${target}, $null) }`,
      `finally { Remove-Item -LiteralPath ${temporary} -Force -ErrorAction SilentlyContinue }`,
    ].join('; ');
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
  }

  const permissions = (mode & 0o777).toString(8).padStart(3, '0');
  const script = [
    'set -e',
    'umask 077',
    `trap ${quoteShellArgument(
      `rm -f ${quoteShellArgument(temporaryPath)}`,
    )} EXIT`,
    `if command -v sha256sum >/dev/null 2>&1; then current_hash=$(sha256sum ${quoteShellArgument(
      targetPath,
    )} | awk '{print $1}'); else current_hash=$(shasum -a 256 ${quoteShellArgument(
      targetPath,
    )} | awk '{print $1}'); fi`,
    `[ "$current_hash" = ${quoteShellArgument(expectedHash)} ] || exit 73`,
    `cp ${quoteShellArgument(sourcePath)} ${quoteShellArgument(temporaryPath)}`,
    `chmod ${permissions} ${quoteShellArgument(temporaryPath)}`,
    `mv -f ${quoteShellArgument(temporaryPath)} ${quoteShellArgument(targetPath)}`,
    'trap - EXIT',
  ].join('\n');
  return `/bin/sh -c ${quoteShellArgument(script)}`;
}

function isElevationCancellation(error: Error): boolean {
  return /cancel|canceled|cancelled|did not grant|denied/i.test(error.message);
}

async function writeWithElevation(
  environment: ProductJsonEnvironment,
  sourcePath: string,
  targetPath: string,
  mode: number,
  expectedHash: string,
): Promise<void> {
  const command = buildProductJsonElevatedCommand(
    environment,
    sourcePath,
    targetPath,
    mode,
    expectedHash,
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    sudoPrompt.exec(
      command,
      { name: 'Unify Chat Provider' },
      (error?: Error) => {
        if (!error) {
          resolvePromise();
          return;
        }
        const errorCode: unknown = Reflect.get(error, 'code');
        rejectPromise(
          new ProductJsonError(
            errorCode === 73
              ? 'concurrent-change'
              : isElevationCancellation(error)
                ? 'cancelled'
                : 'write-failed',
            errorCode === 73
              ? 'product.json changed before the administrator write. No changes were written.'
              : isElevationCancellation(error)
                ? 'Administrator authorization was cancelled.'
                : 'The administrator write operation failed.',
            { cause: error },
          ),
        );
      },
    );
  });
}

async function assertHashUnchanged(
  targetPath: string,
  expectedHash: string,
): Promise<void> {
  const current = await readFile(targetPath);
  if (hashBytes(current) !== expectedHash) {
    throw new ProductJsonError(
      'concurrent-change',
      'product.json changed while it was being prepared. No changes were written.',
    );
  }
}

async function verifyWrittenProduct(
  targetPath: string,
  expectedRoot: Record<string, unknown>,
  extensionId: string,
  proposals: readonly string[],
): Promise<void> {
  let actualRoot: Record<string, unknown>;
  try {
    actualRoot = parseProductBytes(await readFile(targetPath));
  } catch (error) {
    throw new ProductJsonError(
      'verification-failed',
      'Unable to verify product.json after writing.',
      { cause: error },
    );
  }
  if (
    JSON.stringify(actualRoot) !== JSON.stringify(expectedRoot) ||
    !isProductConfiguredForExtension(actualRoot, extensionId, proposals)
  ) {
    throw new ProductJsonError(
      'verification-failed',
      'The written product.json does not contain the expected Proposed API configuration.',
    );
  }
}

export async function inspectProductJson(
  environment: ProductJsonEnvironment,
  proposals: readonly string[],
): Promise<ProductJsonInspection> {
  validateProposalList(proposals);
  const targetPath = resolveTargetPath(environment);
  const document = await readProductDocument(targetPath);
  return {
    targetPath,
    configured: isProductConfiguredForExtension(
      document.root,
      environment.extensionId,
      proposals,
    ),
  };
}

export async function writeProductJsonProposals(
  environment: ProductJsonEnvironment,
  proposals: readonly string[],
): Promise<ProductJsonWriteResult> {
  validateProposalList(proposals);
  const targetPath = resolveTargetPath(environment);
  const original = await readProductDocument(targetPath);
  if (
    isProductConfiguredForExtension(
      original.root,
      environment.extensionId,
      proposals,
    )
  ) {
    return { targetPath, configured: true, changed: false, elevated: false };
  }

  const expectedRoot = createUpdatedProductRoot(
    original.root,
    environment.extensionId,
    proposals,
  );
  const expectedBytes = serializeProductRoot(expectedRoot);
  const backupPath = await createBackup(environment, original);
  const stagingPath = join(
    environment.globalStoragePath,
    `product.${randomUUID()}.staged.json`,
  );
  let elevated = false;
  try {
    await writeFile(stagingPath, expectedBytes, { flag: 'wx', mode: 0o600 });
    await assertHashUnchanged(targetPath, original.hash);
    try {
      await writeAtomically(targetPath, expectedBytes, original.mode);
    } catch (error) {
      if (isReadOnlyError(error)) {
        throw new ProductJsonError(
          'read-only',
          'The VS Code installation is on a read-only filesystem.',
          { cause: error },
        );
      }
      if (!isPermissionError(error)) {
        throw error;
      }
      await assertHashUnchanged(targetPath, original.hash);
      elevated = true;
      await writeWithElevation(
        environment,
        stagingPath,
        targetPath,
        original.mode,
        original.hash,
      );
    }
    await verifyWrittenProduct(
      targetPath,
      expectedRoot,
      environment.extensionId,
      proposals,
    );
    return {
      targetPath,
      configured: true,
      changed: true,
      elevated,
      backupPath,
    };
  } catch (error) {
    if (error instanceof ProductJsonError) {
      throw error;
    }
    throw new ProductJsonError(
      'write-failed',
      'Unable to update the VS Code product.json file.',
      { cause: error },
    );
  } finally {
    await unlinkIfPresent(stagingPath);
  }
}
