---
name: Update Cli Clients
description: Regularly maintain certain clients.
tools:
  [
    vscode/switchAgent,
    vscode/askQuestions,
    execute/testFailure,
    execute/getTerminalOutput,
    execute/awaitTerminal,
    execute/killTerminal,
    execute/runInTerminal,
    read/problems,
    read/readFile,
    read/terminalSelection,
    read/terminalLastCommand,
    agent/runSubagent,
    edit/createDirectory,
    edit/createFile,
    edit/editFiles,
    search/changes,
    search/codebase,
    search/fileSearch,
    search/listDirectory,
    search/searchResults,
    search/textSearch,
    search/searchSubagent,
    search/usages,
    web/fetch,
    web/githubRepo,
    vscode.mermaid-chat-features/renderMermaidDiagram,
    todo,
  ]
---

# Goal

The following clients require regular maintenance and updates, because they are implemented through simulated auth and requests — the official providers may change their auth or request methods, causing the client to break.

The maintenance approach is to reference the source code of the specified reference project.

# Client List

- Claude Code Client: Reference CLIProxyAPI project, local path: `/Users/smallmain/Documents/Work/CLIProxyAPI`
- Github Copilot Client: Reference CLIProxyAPI project, local path: `/Users/smallmain/Documents/Work/CLIProxyAPI`
- Open AI Codex Client: Reference CLIProxyAPI project, local path: `/Users/smallmain/Documents/Work/CLIProxyAPI`
- Antigravity / Gemini CLI Client: Reference CLIProxyAPI project, local path: `/Users/smallmain/Documents/Work/CLIProxyAPI`

If the user explicitly specifies a client, only maintain that client; otherwise, maintain all listed clients.

# Your Role

You are responsible for running subAgents, each handling maintenance of one client.

For each subAgent, they need to:

- If the user explicitly requests a full check, pull the latest code from the reference project and inspect it.
- If the user didn't explicitly request it, only check the code changes between the reference project's current commit and the latest commit.
- Understand the client's auth and request implementation in the project, focusing on request simulation.
- Reference the specified reference project's source code to check if the client needs updating.
- Sync the client's supported model list.
- If updates are needed, modify the corresponding code.
- Finally, sync the reference project to the latest commit (note: if multiple clients share the same reference project, all must be completed before syncing to the latest commit).

## Model ID Sync Rules (Important)

- This project uses its own model config IDs as request input — do not directly copy the reference project's prefixed model IDs or complex alias resolution (e.g. `antigravity-*`).
- Only "protocol-required transformations" are allowed: e.g. Gemini 3 Pro tier suffix, Claude's `-thinking`, Gemini CLI's `-preview`/`-preview-customtools` handling.
- When syncing the model list, first cross-check with this project's `getAvailableModels` and existing config/naming, then decide whether to add or remove; do not write the reference project's internal routing IDs directly as this project's config IDs.
- Use the reference project's model list as the source of truth: delete models from this project that don't exist in the reference project, and add models from the reference project that are missing here, ensuring the final list matches the reference project.
