# Grok ACP 观察记录

本目录只放脱敏后的真机观察。由 [GACP-01](../gacp-01-real-grok-protocol-verification.md) 创建和填写。

规则：

- 禁止提交 API Key、完整 Prompt、`rawInput` / `rawOutput` 原文、环境变量值和完整 JSON-RPC。
- 没见到的字段写 `not-observed`，禁止补“应该有”。
- 受控 fixture 的行为不得写进这些表冒充真实 Grok。

正式表格见 [grok-acp-observation.md](grok-acp-observation.md)。方言版本矩阵见 GACP-04 产出的 `grok-acp-dialect-matrix.md`。

## 用脚本走正式产品路径

不要另写 `grok agent stdio` Client。默认测试也不连真实 Grok。

本机已登录 Grok、并已准备好 Provider Base URL / Key 时，可跑：

```powershell
$env:GACP01_REAL_GROK = "1"
$env:GACP01_PROVIDER_BASE_URL = "https://your-provider.example/v1"
$env:GACP01_PROVIDER_API_KEY = "replace-me"
$env:GACP01_MODEL_ID = "grok-4.5"  # 可选
pnpm test:gacp01:observe
```

脚本会启动隔离 userData 的开发态 Electron，走 `window.provider.save` → `window.agent.connect` → `createTask` → `startTurn`，把脱敏字段写入本目录的观察表。未设置 `GACP01_REAL_GROK=1` 时该 Playwright 套件会 skip。不要在 CI 里跑。
