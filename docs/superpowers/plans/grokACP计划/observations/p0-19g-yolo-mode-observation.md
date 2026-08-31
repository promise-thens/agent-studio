# P0-19g yoloMode / always-approve 真机观察

> 本文件冻结 Task 完全接管的生效路径。观察已在隔离环境完成；实现必须服从本表，不得改写成相反结论。

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | 2026-08-31 |
| Grok CLI | `1.0.13` |
| 通道 | ACP stdio |
| GROK_HOME | 隔离目录（只复制 `auth.json`，**不**复制用户 `config.toml`） |
| `~/.grok/config.toml` 观察前 sha256 | `8e5285e5eeca085d00c2a85b8aa8f86d636178eaddcde2f779cf07e855f5f08e` |
| `~/.grok/config.toml` 观察后 sha256 | `8e5285e5eeca085d00c2a85b8aa8f86d636178eaddcde2f779cf07e855f5f08e` |
| hash 是否不变 | true |
| 进程级 `--always-approve` | **未使用**（也不再试） |

脱敏原始 JSON（gitignored scratch，不入库）：`.superpowers/sdd/p0-19g-task-takeover-always-approve/yolo-observation.json`

## 1. 三场景对照

| 场景 | `session/new` | `request_permission` 次数 | 写文件 marker | 广告 `always-approve` |
| --- | --- | --- | --- | --- |
| A | `{ cwd, mcpServers: [], _meta: { yoloMode: true } }` | **0** | 成功 | 是 |
| B | `{ cwd, mcpServers: [] }` 无 `_meta` | **1**（kinds: `allow_always` / `allow_once` / `reject_once`） | 客户端回了 `allow_once` 后成功 | 是 |
| C | 无 `_meta`，空闲时 `session/prompt` 文本 `/always-approve`，再写文件 | 开关轮 0，随后写文件 **0** | 成功 | 是 |

## 2. 冻结结论

1. **新建 session 接管路径**：`session/new` 带 `_meta.yoloMode: true`，且**只允许这一个 `_meta` 键**。请求形状只记：

   ```ts
   { cwd, mcpServers: [], _meta: { yoloMode: true } }
   ```

2. **不要**用进程级 `grok agent --always-approve stdio`（本轮未使用，也无需再试）。

3. `/always-approve` **有广告**；空闲时作为 prompt 发送可切换当前 session（当轮后续写文件不再 `request_permission`）。命令是否广告只记有无 `always-approve`，不入库完整用户插件命令清单。

4. **关闭路径**：按 Grok 文档视为同一命令再发一次；本轮未单独做关→再写的真机对照。标注：`documented-toggle / not live-verified-off`。关失败时 HUD 不得假装已回到询问（任务 3）。

5. 询问模式仍可能给出 `allow_always` option；产品路径**永远不回** `allow_always`。

6. 未广告或忙碌时，禁止为了开关丢掉可恢复 session；只能 `defer-next-session`。
