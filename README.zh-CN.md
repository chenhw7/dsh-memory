# @chenhw7/dsh-memory

[English](README.md) | **简体中文**

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供长期记忆能力的可安装 profile bundle。跨会话持久化记忆——事实、偏好、修正和经验在会话与重启后仍然保留。

这是一个**自包含的单一包**（不是多包 workspace）。它依赖 dsh 核心服务作为 **peer dependencies**（由你已经安装的 dsh 提供），并通过自带的 `cordis.patch.yml` 让 `dsh plugin add` 将其激活为一个 profile 层。

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [验证](#验证)
- [配置](#配置)
- [架构](#架构)
- [故障排查](#故障排查)
- [已知限制](#已知限制)
- [许可证](#许可证)

## 功能特性

- **持久化记忆** — 将事实、偏好和约定存储在持久的 KV 后端中。
- **三层作用域** — `global`（跨项目）、`project`（按仓库自动检测）、`user`（跨项目 profile）。
- **六个模型可用工具** — `memory_search`、`memory_add`、`memory_replace`、`memory_remove`、`memory_list`、`memory_get`。
- **自动学习** — 投影累加器观察对话，并通过轻量规则提取候选记忆；当候选足够多时，运行 LLM 提取。
- **压缩时自动落盘** — 当压缩使旧上下文失效时，扫描原始事件并保留值得记住的内容。
- **安全扫描** — 阻止 API Key、Token、提示注入模式和泄露尝试被写入记忆。
- **前端可配置** — 所有设置都通过 dsh 设置界面暴露，实时生效。

## 安装

### 前置要求

- 已安装 [Node.js](https://nodejs.org) 和 npm。
- 可以使用 dsh CLI（全局安装或源码构建）：

  ```sh
  npm install -g @deepseek-ai/dsh
  ```

  或者使用 `npx @deepseek-ai/dsh`。

  也可以从源码构建：

  ```sh
  git clone https://github.com/deepseek-ai/deepseek-harness.git
  cd deepseek-harness
  pnpm install
  pnpm run build
  ```

  使用源码时，在 `deepseek-harness` 目录下通过 `pnpm dsh ...` 运行命令（例如 `pnpm dsh web`）。

- 已安装 pnpm。如果没有：

  ```sh
  npm install -g pnpm
  pnpm --version
  ```

- 准备一个要添加记忆能力的 profile（本文以 `web` 为例）。

### 从 GitHub 安装（推荐）

pnpm 会阻止 git 依赖的 `prepare` 构建脚本，直到你显式允许，因此安装分两步。

**第一步：允许构建脚本**

编辑 profile 的 `pnpm-workspace.yaml`：

- Windows：`%USERPROFILE%\.dsh\profiles\web\pnpm-workspace.yaml`
- macOS/Linux：`~/.dsh/profiles/web/pnpm-workspace.yaml`
- 如果设置了 `DSH_HOME`：`$DSH_HOME/profiles/web/pnpm-workspace.yaml`

添加（如果已有内容则合并）：

```yaml
allowBuilds:
  "@chenhw7/dsh-memory@https://codeload.github.com/chenhw7/dsh-memory/tar.gz/045a6f4402fac282fb649787bf3de38cad28c6bb": true
```

> **为什么是这个 URL？** 这是 pnpm 在 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 中打印的依赖 URL，包含解析后的 commit（`045a6f...`）。如果更新 `dsh-memory` 到新 commit，pnpm 可能提示不同的 URL；请同步更新 `allowBuilds`，或继续使用这里固定的 commit。

部分 pnpm 版本使用旧格式：

```yaml
onlyBuiltDependencies:
  - "@chenhw7/dsh-memory"
```

**第二步：安装插件**

```sh
dsh plugin add --profile web https://github.com/chenhw7/dsh-memory
```

如果使用源码构建的 dsh，则在 `deepseek-harness` 目录下执行：

```sh
pnpm dsh plugin add --profile web https://github.com/chenhw7/dsh-memory
```

profile 路径和 `allowBuilds` 步骤与全局安装相同。

固定 commit 安装：

```sh
dsh plugin add --profile web https://github.com/chenhw7/dsh-memory/archive/045a6f4402fac282fb649787bf3de38cad28c6bb.tar.gz
```

### 从本地 checkout 安装

如果你想修改插件，先 clone 并构建，再从本地路径安装：

```sh
git clone https://github.com/chenhw7/dsh-memory.git
cd dsh-memory
npm install && npm run build
dsh plugin add --profile web file:.
```

`file:` 安装仍然会运行 `prepare`，所以通常也需要同样的 `allowBuilds` 允许配置，除非 `lib/` 已经构建好（pnpm 在入口文件已存在时会跳过 `prepare`）。如果 pnpm 打印了需要批准的精确依赖 key，请将它加入 `allowBuilds`（或使用旧的 `onlyBuiltDependencies` 列表）。

### 从 tarball 安装（无需构建权限）

如果你不想授予构建脚本权限，可以从已构建好 `lib/` 的 checkout 打包 tarball 再安装：

```sh
cd dsh-memory
npm install && npm run build
npm pack                    # 生成 chenhw7-dsh-memory-0.1.0.tgz
dsh plugin add --profile web ./chenhw7-dsh-memory-0.1.0.tgz
```

## 验证

安装后，确认组合后的 profile 树中包含四个 memory 行：

```sh
# Windows
dsh --profile web --dump-config | findstr memory
# macOS / Linux
dsh --profile web --dump-config | grep memory
```

你应该看到四个指向 `@chenhw7/dsh-memory/*` 的行：

```
- id: memory-store
  name: '@chenhw7/dsh-memory/store'
- id: tool-memory
  name: '@chenhw7/dsh-memory/tool'
- id: memory-review
  name: '@chenhw7/dsh-memory/review'
- id: memory-context
  name: '@chenhw7/dsh-memory/context'
```

然后启动 dsh，检查设置界面是否显示 `memory` 命名空间：

```sh
dsh web
```

## 配置

所有设置都可以在 dsh 前端设置页（`memory` 命名空间）中编辑并实时生效，持久化在 `$DSH_HOME/settings.yaml`。

| 设置 | 默认值 | 说明 |
|---|---|---|
| `memoryMode` | `policy-only` | `full`：注入记忆内容 + 指引；`policy-only`：只注入指引，模型按需搜索；`custom`：注入用户自定义策略文本；`off`：不注入。 |
| `memoryPolicyCustomText` | — | 当 `memoryMode` 为 `custom` 时使用的自定义策略文本。 |
| `reviewEnabled` | `true` | 启用自动周期性 review 提取。 |
| `reviewCandidateThreshold` | `10` | 触发 LLM 提取前的候选消息数。 |
| `flushOnCompaction` | `true` | 压缩后从被遮蔽的事件中提取记忆。 |
| `flushOnDispose` | `true` | 会话销毁时提取剩余上下文。 |
| `memoryCharLimit` | `5000` | 每个作用域注入记忆内容的字符上限。 |

## 架构

该 bundle 在 `dsh-base` 之上插入四行，每行指向本包自己的导出子路径：

| 行 | 导出 | 作用 |
|---|---|---|
| `memory-store` | `@chenhw7/dsh-memory/store` | 打开 `memory` 域，注册 `ctx.memory` |
| `tool-memory` | `@chenhw7/dsh-memory/tool` | 六个模型可用工具 |
| `memory-review` | `@chenhw7/dsh-memory/review` | 自动提取（投影 + flush） |
| `memory-context` | `@chenhw7/dsh-memory/context` | 系统提示注入 + 设置命名空间 |

**存储**：本 bundle **不**插入 `storage-json` / `storage-domain` 行。`dsh-web-app` bundle 已经提供它们（并在 `$DSH_HOME/storages` 下使用正确的根路径）。如果在这里重复插入，会覆盖已有配置（patch 会替换整行，后写覆盖先写）。memory store provider 将 `storageDomain` 服务作为 peer dependency 使用。

### Headless profiles

`dsh-headless` **不**自带存储层。要在 `dsh --profile headless` 中使用本 bundle，需要把存储行添加到你的 profile 的 `cordis.patch.yml`（不要加在本 bundle 的 patch 中）：

```yaml
# $DSH_HOME/profiles/headless/cordis.patch.yml
- insert:
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

## 故障排查

### `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

如果 `dsh plugin add` 报错，例如：

```text
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package ...
The git-hosted package "@chenhw7/dsh-memory@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.
```

说明 pnpm 还没有被允许执行该包的 `prepare` 构建脚本。

**解决方法：**

1. 打开 profile 的 `pnpm-workspace.yaml`（路径见上文）。
2. 根据错误信息添加精确的 `allowBuilds` 条目，格式类似：

   ```yaml
   allowBuilds:
     "@chenhw7/dsh-memory@https://codeload.github.com/chenhw7/dsh-memory/tar.gz/<commit>": true
   ```

3. 重新执行 `dsh plugin add`。

> 如果你更新了 `dsh-memory` 到新 commit，错误中的 URL 可能会变化。请将 `allowBuilds` 更新为新 URL，或者继续固定使用已经允许的 commit。

## 已知限制

- **无语义/向量检索** — `memory_search` 是对结构化 KV 条目的子串匹配，不是 embeddings。
- **提取质量跟随会话模型** — review/flush 复用会话当前路由的 provider/model。
- **git 安装需要构建允许** — pnpm 会阻止 `prepare` 脚本，直到你为精确依赖添加 `allowBuilds` 条目。可以使用 tarball 或 npm publish 来避免。
- **dsh 仍处于开发者预览阶段** — 可能会有破坏性变更；本 bundle 的 peer dependency 范围跟随 dsh 发布线。

## 许可证

MIT
