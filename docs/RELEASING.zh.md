# 发布流程（npm release runbook）

`@chenhw7/dsh-memory` 的发布完全由 GitHub Actions 完成（OIDC trusted publishing）：
本地不需要 `npm login`，没有任何 npm 凭据要保管或迁移，Windows / Linux / macOS 上操作完全一致。
实际的构建、测试、发布都发生在 GitHub 的 ubuntu runner 上，npm 端校验的是「哪个仓库的哪个 workflow」在发，
与哪台电脑无关。

## 日常发版（三条命令）

```bash
git status                          # 1. 确认工作区干净、main 已与远程同步
npm version patch                   # 2. bump 版本号 + 自动生成提交和 tag（v0.5.x）
git push origin main --tags         # 3. 推送 → tag 触发 publish.yml
```

版本号选择：安全修复 / bug 修复用 `patch`；新增向后兼容的功能用 `minor`；破坏性变更用 `major`。
`npm version` 要求工作区干净，否则会拒绝执行。

## CI 自动做什么

触发后（见 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)）：

1. 校验 tag 名与 `package.json` 的 `version` 一致，不一致直接失败；
2. 安装 Node 22 + npm ≥ 11.5.1（OIDC 信任发布所需）；
3. `npm ci` → `prepublishOnly`（`npm run build && npm run test`，全量测试通过才继续）；
4. `npm publish --provenance`：以 OIDC 令牌向 npm 证明「发布来自 `chenhw7/dsh-memory` 的 `publish.yml`」，
   npm 对照 Trusted Publisher 配置放行，并给包附上溯源（provenance）签名。

## 发布后验证

```bash
npm view @chenhw7/dsh-memory version dist-tags   # latest 应为新版本
```

## 常见故障与处理

| 现象 | 原因与处理 |
|---|---|
| CI 报 `ENEEDAUTH` | OIDC 链路断了。检查 npm 端 Trusted Publisher 配置是否仍在且匹配（见下节），以及 workflow 是否保留了 `permissions: id-token: write` |
| `tag vX.Y.Z does not match package.json version` | tag 名与版本号不一致。把 tag 移到正确提交：`git tag -f vX.Y.Z <commit> && git push --force origin vX.Y.Z` |
| 测试/构建失败 | 修复后提交到 main，再把 tag 移到新提交重推（同上）。注意先确认该版本号还没被 npm 接受 |
| npm 报「cannot publish over the previously published versions」 | 该版本号已上架，npm 不允许覆盖。只能 bump 出新版本号 |
| `npm publish` 报 403 | 2026-08 之后不应再出现：workflow 已不含任何 token 认证。若出现说明 workflow 被改回了 token 模式而仓库没有 `NPM_TOKEN` secret |

**移动已推送的 tag** 只在「该版本号还没被 npm 接受」时是安全的；一旦上架，npm 视版本号为不可变，
唯一出路是发新版本号。

## 一次性前提配置（已就绪，留档备查）

发布能力由两处配置共同决定，任一侧丢失都会 `ENEEDAUTH`：

- **npm 端**（npmjs.com → 包 → Settings → Trusted Publisher）：
  Publisher = GitHub Actions；Organization or user = `chenhw7`；Repository = `dsh-memory`；
  Workflow filename = `publish.yml`；**Environment name 留空**（workflow 未声明 environment，两边必须一致）；
  Allowed actions 勾 Publish。
- **仓库端**：`publish.yml` 中 job 带 `permissions: id-token: write`，发布命令为
  `npm publish --provenance`。仓库不需要任何 secret（历史上用过的 `NPM_TOKEN` 方案已废弃）。

## 信任边界

谁有权限向本仓库推送 `v*` tag，谁就能触发发布——协作者的「写代码权」实际隐含「发版权」。
若日后需要把两者分离：在 GitHub 仓库建一个 environment 并设置 required reviewers，
在 `publish.yml` 的 job 上声明 `environment: <名>`，并在 npm 端 Trusted Publisher 里填同名环境。
此后每次发布会卡在 Actions 等人工批准，仅推 tag 无法直接发版。

## 换电脑需要什么

唯一与本地相关的准备：装 Node/npm（跑 `npm version` 和本地测试）、配好 GitHub 推送凭据
（HTTPS 凭据管理器或 SSH key）。没有 npm 凭据要迁移。
