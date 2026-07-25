import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

const MINIMUM_SUPPORTED_VSCODE_VERSION = "1.115.0";
const AUTH_E2E_BINDING = "00000000-0000-4000-8000-000000000901";
const AUTH_E2E_ENVELOPE_KEY =
  `ucp:state:auth-session-v1.${AUTH_E2E_BINDING}`;
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const AUTH_ISOLATION_RESULT_KEYS: readonly string[] = [
  "phase",
  "processId",
  "method",
  "bindingId",
  "revision",
  "credentialDigest",
  "accountDigest",
  "sessionDigest",
];

type AuthIsolationPhase =
  | "device-a-login"
  | "device-b-login"
  | "device-a-verify";

interface AuthIsolationResult {
  readonly phase: AuthIsolationPhase;
  readonly processId: number;
  readonly method: "openai-codex";
  readonly bindingId: string;
  readonly revision: number;
  readonly credentialDigest: string;
  readonly accountDigest: string;
  readonly sessionDigest: string;
}

interface AuthSecretSummary {
  readonly revision: number;
  readonly credentialDigest: string;
  readonly refreshDigest: string;
  readonly accountDigest: string;
  readonly sessionDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(contents: string, description: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`Invalid ${description} JSON.`);
  }
}

function requireDigest(value: unknown, description: string): string {
  if (typeof value !== "string" || !SHA256_REGEX.test(value)) {
    throw new Error(`Invalid ${description} digest.`);
  }
  return value;
}

function parseAuthIsolationResult(
  value: unknown,
  expectedPhase: AuthIsolationPhase,
): AuthIsolationResult {
  if (!isRecord(value)) {
    throw new Error("Invalid auth isolation result.");
  }
  if (
    !Object.keys(value).every((key) =>
      AUTH_ISOLATION_RESULT_KEYS.includes(key),
    ) ||
    Object.keys(value).length !== AUTH_ISOLATION_RESULT_KEYS.length
  ) {
    throw new Error("Invalid auth isolation result fields.");
  }
  const processId = value["processId"];
  const revision = value["revision"];
  if (
    value["phase"] !== expectedPhase ||
    value["method"] !== "openai-codex" ||
    value["bindingId"] !== AUTH_E2E_BINDING ||
    typeof processId !== "number" ||
    !Number.isSafeInteger(processId) ||
    processId <= 0 ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error("Invalid auth isolation result.");
  }
  return {
    phase: expectedPhase,
    processId,
    method: "openai-codex",
    bindingId: AUTH_E2E_BINDING,
    revision,
    credentialDigest: requireDigest(
      value["credentialDigest"],
      "credential",
    ),
    accountDigest: requireDigest(value["accountDigest"], "account"),
    sessionDigest: requireDigest(value["sessionDigest"], "session"),
  };
}

async function readAuthIsolationResult(
  file: string,
  phase: AuthIsolationPhase,
): Promise<AuthIsolationResult> {
  const contents = await readFile(file, "utf8");
  return parseAuthIsolationResult(
    parseJson(contents, "auth isolation result"),
    phase,
  );
}

async function inspectAuthSecretFile(
  file: string,
  expected: AuthIsolationResult,
  expectedDevice: "a" | "b",
): Promise<AuthSecretSummary> {
  const stored = parseJson(
    await readFile(file, "utf8"),
    "auth isolation SecretStorage",
  );
  if (!isRecord(stored)) {
    throw new Error("Invalid auth isolation SecretStorage structure.");
  }
  for (const value of Object.values(stored)) {
    if (typeof value !== "string") {
      throw new Error("Invalid auth isolation SecretStorage structure.");
    }
  }

  const envelopeRaw = stored[AUTH_E2E_ENVELOPE_KEY];
  if (typeof envelopeRaw !== "string") {
    throw new Error("Missing auth isolation SecretStorage state.");
  }
  const envelope = parseJson(envelopeRaw, "local auth envelope");
  if (
    !isRecord(envelope) ||
    envelope["version"] !== 1 ||
    envelope["bindingId"] !== AUTH_E2E_BINDING ||
    envelope["revision"] !== expected.revision ||
    !Array.isArray(envelope["snapshots"]) ||
    envelope["snapshots"].length < 1
  ) {
    throw new Error("Invalid auth isolation SecretStorage state.");
  }

  const snapshot = envelope["snapshots"].find(
    (candidate: unknown) =>
      isRecord(candidate) &&
      candidate["method"] === "openai-codex" &&
      typeof candidate["staticConfigFingerprint"] === "string" &&
      SHA256_REGEX.test(candidate["staticConfigFingerprint"]),
  );
  if (!isRecord(snapshot)) {
    throw new Error("Missing auth isolation session snapshot.");
  }
  const token = snapshot["token"];
  const context = snapshot["authContext"];
  const sessionId = snapshot["sessionId"];
  if (
    !isRecord(token) ||
    typeof token["accessToken"] !== "string" ||
    typeof token["refreshToken"] !== "string" ||
    token["tokenType"] !== "Bearer" ||
    !isRecord(context) ||
    context["method"] !== "openai-codex" ||
    context["bindingId"] !== AUTH_E2E_BINDING ||
    context["revision"] !== expected.revision ||
    typeof context["accountId"] !== "string" ||
    typeof context["sessionId"] !== "string" ||
    typeof sessionId !== "string" ||
    context["sessionId"] !== sessionId
  ) {
    throw new Error("Invalid auth isolation session snapshot.");
  }

  const summary = {
    revision: expected.revision,
    credentialDigest: createHash("sha256")
      .update(token["accessToken"])
      .digest("hex"),
    refreshDigest: createHash("sha256")
      .update(token["refreshToken"])
      .digest("hex"),
    accountDigest: createHash("sha256")
      .update(context["accountId"])
      .digest("hex"),
    sessionDigest: createHash("sha256").update(sessionId).digest("hex"),
  };
  const expectedCredentialDigest = createHash("sha256")
    .update(`device-${expectedDevice}-access-token`)
    .digest("hex");
  const expectedRefreshDigest = createHash("sha256")
    .update(`device-${expectedDevice}-refresh-token`)
    .digest("hex");
  const expectedAccountDigest = createHash("sha256")
    .update(`account-${expectedDevice}`)
    .digest("hex");
  if (
    summary.credentialDigest !== expected.credentialDigest ||
    summary.credentialDigest !== expectedCredentialDigest ||
    summary.refreshDigest !== expectedRefreshDigest ||
    summary.accountDigest !== expected.accountDigest ||
    summary.accountDigest !== expectedAccountDigest ||
    summary.sessionDigest !== expected.sessionDigest
  ) {
    throw new Error("Auth isolation SecretStorage digest mismatch.");
  }
  return summary;
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");
      hash.update(
        entry.isDirectory() ? `d:${relativePath}\0` : `f:${relativePath}\0`,
      );
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        hash.update(await readFile(absolutePath));
        hash.update("\0");
      }
    }
  };

  await visit(root);
  return hash.digest("hex");
}

async function createNotebookContributionExtension(
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const testManifest = {
    name: "ucp-e2e-notebook-contribution",
    displayName: "UCP E2E Notebook Contribution",
    publisher: "ucp-e2e",
    version: "0.0.0",
    engines: { vscode: `^${MINIMUM_SUPPORTED_VSCODE_VERSION}` },
    contributes: {
      notebooks: [
        {
          type: "ucp-e2e-notebook",
          displayName: "UCP E2E Notebook",
          selector: [{ filenamePattern: "*.ucpe2e" }],
        },
      ],
    },
  };
  await writeFile(
    path.join(destination, "package.json"),
    `${JSON.stringify(testManifest, undefined, 2)}\n`,
  );
}

async function createFakeLanguageModelExtension(
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const testManifest = {
    name: "fake-language-model",
    displayName: "UCP E2E Fake Language Model",
    publisher: "ucp-e2e",
    version: "0.0.0",
    engines: { vscode: `^${MINIMUM_SUPPORTED_VSCODE_VERSION}` },
    main: "./extension.js",
    activationEvents: ["*"],
    enabledApiProposals: ["chatProvider", "languageModelSystem"],
    contributes: {
      languageModelChatProviders: [
        {
          vendor: "ucp-e2e-fake",
          displayName: "UCP E2E Fake Language Model",
        },
      ],
      commands: [
        {
          command: "ucpE2E.fakeLanguageModel.setResponses",
          title: "Set Fake Language Model Responses",
        },
        {
          command: "ucpE2E.fakeLanguageModel.getRequests",
          title: "Get Fake Language Model Requests",
        },
        {
          command: "ucpE2E.fakeLanguageModel.setRegistered",
          title: "Register or Unregister the Fake Language Model",
        },
      ],
    },
  };
  const extensionSource = String.raw`
const vscode = require('vscode');

let responses = [{ chunks: ['<NO_CHANGE>'] }];
let responseIndex = 0;
const requests = [];

function normalizeResponse(value) {
  if (typeof value === 'string') {
    return { chunks: [value] };
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.chunks)) {
    return undefined;
  }
  if (value.chunks.some(chunk => typeof chunk !== 'string')) {
    return undefined;
  }
  if (
    value.match !== undefined &&
    (
      !value.match ||
      typeof value.match !== 'object' ||
      typeof value.match.includes !== 'string' ||
      value.match.includes.length === 0 ||
      (
        value.match.role !== undefined &&
        value.match.role !== 'system' &&
        value.match.role !== 'user'
      )
    )
  ) {
    return undefined;
  }
  return {
    chunks: [...value.chunks],
    delayMs: typeof value.delayMs === 'number' && value.delayMs >= 0 ? value.delayMs : 0,
    chunkDelayMs: typeof value.chunkDelayMs === 'number' && value.chunkDelayMs >= 0 ? value.chunkDelayMs : 0,
    error: typeof value.error === 'string' ? value.error : undefined,
    match: value.match === undefined
      ? undefined
      : {
          includes: value.match.includes,
          role: value.match.role,
        },
  };
}

function setResponses(value) {
  const values = value && typeof value === 'object' && Array.isArray(value.responses)
    ? value.responses
    : value === undefined
      ? ['<NO_CHANGE>']
      : [value];
  const normalized = values.map(normalizeResponse);
  if (normalized.length === 0 || normalized.some(value => value === undefined)) {
    throw new Error('Invalid fake language model response program.');
  }
  responses = normalized;
  responseIndex = 0;
  requests.length = 0;
}

function waitForDelay(delayMs, token) {
  if (delayMs <= 0 || token.isCancellationRequested) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let subscription;
    const handle = setTimeout(() => {
      if (subscription) subscription.dispose();
      resolve();
    }, delayMs);
    subscription = token.onCancellationRequested(() => {
      clearTimeout(handle);
      subscription.dispose();
      resolve();
    });
  });
}

function messageText(message) {
  return message.content
    .filter(part => part instanceof vscode.LanguageModelTextPart)
    .map(part => part.value)
    .join('');
}

function roleName(role) {
  if (role === vscode.LanguageModelChatMessageRole.System) return 'system';
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  return 'user';
}

function activate(context) {
  const provider = {
    provideLanguageModelChatInformation() {
      return [{
        id: 'controlled',
        name: 'UCP E2E Controlled Model',
        family: 'ucp-e2e',
        version: '1',
        maxInputTokens: 128000,
        maxOutputTokens: 4096,
        capabilities: {},
      }];
    },
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      const messageRecords = messages.map(message => ({
        role: roleName(message.role),
        content: messageText(message),
      }));
      const modelOptions = options.modelOptions ? { ...options.modelOptions } : {};
      const record = {
        modelId: model.id,
        messages: messageRecords,
        modelOptions,
        justification: options.justification,
        messageBytes: Buffer.byteLength(messageRecords.map(message => message.content).join(''), 'utf8'),
        optionsBytes: Buffer.byteLength(JSON.stringify(modelOptions), 'utf8'),
        cancellationRequested: token.isCancellationRequested,
      };
      requests.push(record);
      const cancellation = token.onCancellationRequested(() => {
        record.cancellationRequested = true;
      });
      const matchingResponse = responses.find(response =>
        response.match &&
        messageRecords.some(message =>
          (response.match.role === undefined || response.match.role === message.role) &&
          message.content.includes(response.match.includes),
        ),
      );
      const sequentialResponses = responses.filter(response => !response.match);
      const index = Math.min(responseIndex, sequentialResponses.length - 1);
      const response = matchingResponse || sequentialResponses[index];
      if (!matchingResponse) {
        responseIndex += 1;
      }
      if (!response) {
        throw new Error('No fake language model response matched the request.');
      }
      try {
        await waitForDelay(response.delayMs || 0, token);
        if (token.isCancellationRequested) return;
        if (response.error) throw new Error(response.error);
        for (const chunk of response.chunks) {
          await waitForDelay(response.chunkDelayMs || 0, token);
          if (token.isCancellationRequested) return;
          progress.report(new vscode.LanguageModelTextPart(chunk));
        }
      } finally {
        cancellation.dispose();
      }
    },
    async provideTokenCount(_model, text) {
      return typeof text === 'string' ? text.length : messageText(text).length;
    },
  };
  let providerRegistration;
  const setRegistered = enabled => {
    providerRegistration?.dispose();
    providerRegistration = enabled
      ? vscode.lm.registerLanguageModelChatProvider('ucp-e2e-fake', provider)
      : undefined;
  };
  setRegistered(true);
  context.subscriptions.push(
    { dispose: () => providerRegistration?.dispose() },
    vscode.commands.registerCommand('ucpE2E.fakeLanguageModel.setResponses', value => {
      setResponses(value);
      return true;
    }),
    vscode.commands.registerCommand('ucpE2E.fakeLanguageModel.getRequests', () =>
      requests.map(request => ({
        ...request,
        messages: request.messages.map(message => ({ ...message })),
        modelOptions: { ...request.modelOptions },
      })),
    ),
    vscode.commands.registerCommand('ucpE2E.fakeLanguageModel.setRegistered', enabled => {
      setRegistered(enabled === true);
      return true;
    }),
  );
}

exports.activate = activate;
exports.deactivate = function () {};
`;
  await Promise.all([
    writeFile(
      path.join(destination, "package.json"),
      `${JSON.stringify(testManifest, undefined, 2)}\n`,
    ),
    writeFile(path.join(destination, "extension.js"), extensionSource),
  ]);
}

async function main(): Promise<void> {
  const sourceExtensionPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite");
  const fixtureWorkspaceSource = path.join(
    sourceExtensionPath,
    "test/e2e/fixtures/workspace",
  );
  const isolationRoot = await mkdtemp(path.join(tmpdir(), "ucp-e2e-"));
  const fixtureHashBefore = await hashDirectory(fixtureWorkspaceSource);

  try {
    const runMode = async (mode: "enabled" | "disabled"): Promise<void> => {
      const modeRoot = path.join(isolationRoot, mode);
      const userDataDir = path.join(modeRoot, "user-data");
      const extensionsDir = path.join(modeRoot, "extensions");
      const fixtureWorkspace = path.join(modeRoot, "workspace");
      const notebookContributionPath = path.join(
        modeRoot,
        "notebook-contribution",
      );
      const fakeLanguageModelPath = path.join(
        modeRoot,
        "fake-language-model",
      );
      await createNotebookContributionExtension(notebookContributionPath);
      await createFakeLanguageModelExtension(fakeLanguageModelPath);
      await cp(fixtureWorkspaceSource, fixtureWorkspace, { recursive: true });
      const proposalArgs =
        mode === "enabled"
          ? [
              "--enable-proposed-api=SmallMain.vscode-unify-chat-provider",
              "--enable-proposed-api=ucp-e2e.fake-language-model",
            ]
          : [];
      await runTests({
        extensionDevelopmentPath: [
          sourceExtensionPath,
          notebookContributionPath,
          fakeLanguageModelPath,
        ],
        extensionTestsPath,
        extensionTestsEnv: { UCP_E2E_PROPOSED_MODE: mode },
        launchArgs: [
          fixtureWorkspace,
          `--user-data-dir=${userDataDir}`,
          `--extensions-dir=${extensionsDir}`,
          "--disable-extensions",
          ...proposalArgs,
          "--skip-welcome",
          "--skip-release-notes",
        ],
      });
    };

    const runAuthIsolation = async (): Promise<void> => {
      // Keep macOS IPC socket paths below the 104-byte sockaddr_un limit.
      const authRoot = path.join(isolationRoot, "a");
      const fixtureWorkspace = path.join(authRoot, "w");
      const deviceAUserData = path.join(authRoot, "d1", "u");
      const deviceBUserData = path.join(authRoot, "d2", "u");
      const deviceASecretFile = path.join(authRoot, "d1", "secrets.json");
      const deviceBSecretFile = path.join(authRoot, "d2", "secrets.json");
      await cp(fixtureWorkspaceSource, fixtureWorkspace, { recursive: true });

      const runPhase = async (
        phase: AuthIsolationPhase,
        userDataDir: string,
        secretFile: string,
      ): Promise<AuthIsolationResult> => {
        const deviceRoot = path.dirname(userDataDir);
        const resultFile = path.join(authRoot, `${phase}.result.json`);
        await runTests({
          extensionDevelopmentPath: sourceExtensionPath,
          extensionTestsPath,
          extensionTestsEnv: {
            UCP_E2E_AUTH_ISOLATION_PHASE: phase,
            UCP_E2E_AUTH_ISOLATION_RESULT_FILE: resultFile,
            UCP_E2E_SECRET_STORAGE_FILE: secretFile,
          },
          launchArgs: [
            fixtureWorkspace,
            `--user-data-dir=${userDataDir}`,
            `--extensions-dir=${path.join(deviceRoot, "extensions")}`,
            "--disable-extensions",
            "--enable-proposed-api=SmallMain.vscode-unify-chat-provider",
            "--skip-welcome",
            "--skip-release-notes",
          ],
        });
        return await readAuthIsolationResult(resultFile, phase);
      };

      const deviceASettings = path.join(
        deviceAUserData,
        "User",
        "settings.json",
      );
      const deviceBSettings = path.join(
        deviceBUserData,
        "User",
        "settings.json",
      );

      await mkdir(path.dirname(deviceASettings), { recursive: true });
      await writeFile(
        deviceASettings,
        `${JSON.stringify(
          {
            "unifyChatProvider.endpoints": [
              {
                type: "openai-responses",
                name: "auth-isolation-e2e",
                baseUrl: "https://api.openai.com/v1",
                auth: {
                  method: "openai-codex",
                  bindingId: "00000000-0000-4000-8000-000000000901",
                },
                models: [{ id: "gpt-5" }],
              },
            ],
          },
          undefined,
          2,
        )}\n`,
      );

      const deviceALogin = await runPhase(
        "device-a-login",
        deviceAUserData,
        deviceASecretFile,
      );
      const deviceASecretAfterLogin = await inspectAuthSecretFile(
        deviceASecretFile,
        deviceALogin,
        "a",
      );
      await mkdir(path.dirname(deviceBSettings), { recursive: true });
      await cp(deviceASettings, deviceBSettings);
      const synchronizedSettings = await readFile(deviceASettings);

      const deviceBLogin = await runPhase(
        "device-b-login",
        deviceBUserData,
        deviceBSecretFile,
      );
      await inspectAuthSecretFile(deviceBSecretFile, deviceBLogin, "b");
      const deviceBSettingsAfterLogin = await readFile(deviceBSettings);
      if (!synchronizedSettings.equals(deviceBSettingsAfterLogin)) {
        throw new Error(
          "Device-local authentication unexpectedly changed synchronized settings.",
        );
      }
      if (deviceALogin.sessionDigest === deviceBLogin.sessionDigest) {
        throw new Error("Independent devices unexpectedly share an auth session.");
      }

      await cp(deviceBSettings, deviceASettings);
      const deviceAVerify = await runPhase(
        "device-a-verify",
        deviceAUserData,
        deviceASecretFile,
      );
      const deviceASecretAfterRestart = await inspectAuthSecretFile(
        deviceASecretFile,
        deviceAVerify,
        "a",
      );
      if (
        deviceAVerify.revision !== deviceALogin.revision ||
        deviceAVerify.sessionDigest !== deviceALogin.sessionDigest ||
        deviceAVerify.credentialDigest !== deviceALogin.credentialDigest ||
        deviceAVerify.accountDigest !== deviceALogin.accountDigest ||
        deviceASecretAfterRestart.revision !==
          deviceASecretAfterLogin.revision ||
        deviceASecretAfterRestart.sessionDigest !==
          deviceASecretAfterLogin.sessionDigest ||
        deviceASecretAfterRestart.credentialDigest !==
          deviceASecretAfterLogin.credentialDigest ||
        deviceASecretAfterRestart.accountDigest !==
          deviceASecretAfterLogin.accountDigest
      ) {
        throw new Error("Device A auth session did not survive restart.");
      }
      if (
        new Set([
          deviceALogin.processId,
          deviceBLogin.processId,
          deviceAVerify.processId,
        ]).size !== 3
      ) {
        throw new Error("Auth isolation phases did not use distinct processes.");
      }
    };

    if (process.env["UCP_E2E_AUTH_ISOLATION_ONLY"] !== "1") {
      await runMode("enabled");
      await runMode("disabled");
    }
    await runAuthIsolation();
  } finally {
    const fixtureHashAfter = await hashDirectory(fixtureWorkspaceSource);
    await rm(isolationRoot, { recursive: true, force: true });
    if (fixtureHashAfter !== fixtureHashBefore) {
      throw new Error(
        "Extension Host test modified the repository fixture workspace.",
      );
    }
  }
}

void main().catch((error: unknown) => {
  console.error("Extension Host tests failed:", error);
  process.exitCode = 1;
});
