我有一个初步的方案，你帮我完善它：
增加对供应商余额监控的功能。

它会定时、在聊天请求结束后进行刷新，所以需要一个管理器统一管理自动刷新。

在供应商配置中增加 balanceProvider 字段，该字段像身份验证方式一样，可以调整该模型使用的 balanceProvider 类型。

该字段在 UI 中展示：

未配置状态：description 显示未配置，点击则展示所有可用的 balanceProvider。
已配置状态：description 是 monitor 类型，detail 显示余额信息，点击字段会进入二级界面，展示该模型的余额监控信息，最下方有 重新配置... 按钮。

添加 src/balance 目录，所有相关文件放在这个目录中。

流程可参考 AuthProvider。

不同供应商获取/显示余额的方式不同，所以需要一个 inteface BalanceProvider。

这个 interface 需要一些接口，比如 getFieldDetail(), configure()，refresh() 等等。

这些接口允许将 ProviderConfig、身份验证信息作为参数传入。

就像 AuthProvider 一样，不同的 BalanceProvider 也有不同的配置。

你的重点是完成这个框架，能够非常简单地添加新的 BalanceProvider。

之后可以使用 subAgent 来添加下面两个 BalanceProvider，正好对应着需要额外配置和不需要额外配置的两种情况：

MoonshotAIBalanceProvider:

- 通过 API Key 调用 API 接口即可获取余额信息。
- 文档：https://platform.moonshot.cn/docs/api/balance
- 设为 Moonshot AI 默认的 balanceProvider （除 Coding Plan）。
- 该 Provider 直接使用 ProviderConfig 中的 BaseUrl 和 ApiKey，所以无需任何额外配置。

NewAPIBalanceProvider:

- 该供应商有两重余额信息，用户余额信息还有 ApiKey 本身的余额信息。
- 用户可选配置用户余额信息，不配置也会显示 ApiKey 本身的余额信息。
- 查询 ApiKey 余额接口：api/usage/token
- 查询 ApiKey 余额接口需要 Authorization 请求头，值为 `Bearer {apikey}`。
- 返回数据格式类似：{
  "code": true,
  "data": {
  "expires_at": 0,
  "model_limits": {},
  "model_limits_enabled": false,
  "name": "Key2",
  "object": "token_usage",
  "total_available": -27099744,
  "total_granted": 0,
  "total_used": 27099744,
  "unlimited_quota": true
  },
  "message": "ok"
  }
- ApiKey 可能是无限余额的。
- 查询用户余额接口文档：https://apiai.apifox.cn/api-289406470
- 通过 BaseURL，UserId 和 SystemToken 获取用户余额信息，UserId 和 SystemToken 需要用户提供配置。
- SystemToken 是敏感数据。
