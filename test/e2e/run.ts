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
  return {
    chunks: [...value.chunks],
    delayMs: typeof value.delayMs === 'number' && value.delayMs >= 0 ? value.delayMs : 0,
    chunkDelayMs: typeof value.chunkDelayMs === 'number' && value.chunkDelayMs >= 0 ? value.chunkDelayMs : 0,
    error: typeof value.error === 'string' ? value.error : undefined,
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
      const index = Math.min(responseIndex, responses.length - 1);
      responseIndex += 1;
      const response = responses[index];
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

    await runMode("enabled");
    await runMode("disabled");
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
