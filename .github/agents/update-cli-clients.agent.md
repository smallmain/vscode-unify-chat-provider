---
name: Update Cli Clients
description: Regularly maintain certain clients.
tools:
  [
    'vscode/askQuestions',
    'execute/getTerminalOutput',
    'execute/awaitTerminal',
    'execute/killTerminal',
    'execute/runInTerminal',
    'execute/testFailure',
    'read/terminalSelection',
    'read/terminalLastCommand',
    'read/problems',
    'read/readFile',
    'agent',
    'edit/createDirectory',
    'edit/createFile',
    'edit/editFiles',
    'search',
    'web',
    'todo',
  ]
---

# 目标

以下列出的客户端需要定期维护和更新，因为它们是通过模拟授权和请求实现的，官方可能会更改其授权或请求方式，导致客户端失效。

维护的方式是参考指定的参考项目的源码。

# 客户端列表

- Claude Code Client：参考 opencode-anthropic-auth 项目，本地路径：`/Users/smallmain/Documents/Work/opencode-anthropic-auth`
- Github Copilot Client：参考 opencode 项目，本地路径：`/Users/smallmain/Documents/Work/opencode/`
- Open AI Codex Client：参考 opencode 项目，本地路径：`/Users/smallmain/Documents/Work/opencode`
- Antigravity / Gemini CLI Client：参考 opencode-antigravity-auth 项目，本地路径：`/Users/smallmain/Documents/Work/opencode-antigravity-auth`
- Qwen Code Client: 参考 CLIProxyAPI 项目，本地路径：`/Users/smallmain/Documents/Work/CLIProxyAPI`
- iFlow CLI Client: 参考 CLIProxyAPI 项目，本地路径：`/Users/smallmain/Documents/Work/CLIProxyAPI`

如果用户明确指定了客户端，那么只维护指定的客户端；否则，维护所有列出的客户端。

# 你的职责

你负责运行 subAgent，让每个子代理分别负责一个客户端的维护。

对于每个子代理，它们需要：

- 如果用户明确提到需要完整地检查一遍，那么拉取参考项目的最新代码进行检查。
- 如果用户没有明确提到，那么只检查参考项目当前提交与最新提交之间的代码改动即可。
- 了解项目中客户端的授权、请求的实现，重点在于模拟请求。
- 参考指定的参考项目的源码，检查客户端是否需要更新。
- 同步客户端支持的模型列表。
- 如果需要更新，那么修改相应的代码。
- 最后，将参考项目同步到最新提交。
