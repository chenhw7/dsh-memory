# Agent Note: eval 工作区 fixture——指向仓库的对话得到一个物化的仓库

Status: implemented

[English](2026-09-07-eval-workspace-fixture-repo.md) | 中文

## Problem

2026-09-07 的真实 judged 切片暴露的两条语料发现共享一个根因：eval 子进程的 cwd 是一次性 home 根目录——一个空目录——于是埋点对话里的「这个仓库」在工作区内没有指称对象，而子进程没有文件系统沙箱；模型把这句话解析到了真实的宿主磁盘上。prog101 的追问会话逐字引用了本仓库的真实文件（AGENTS.md 的 `npm ci` 行、package-lock.json、ci.yml），并让文件证据证伪了场景的反事实埋点前提——它的答案 0 是语料效度失败，不是记忆链失败。prog104 的埋点对话逃进宿主机上真实的 harness 检出后不再收敛：65>64、97>96，两次都精确撞在预算+1 上，不收敛循环。两个场景在被语料停止「把模型引向工作区里不存在的仓库」之前，对真模型不可跑（[发现记录](../architecture/2026-09-04-write-path-rework-implementation-plan.zh.md)「Eval 通道结果（2026-09-07）」）。

## Decision

语料上的工作区 fixture 轴 + 物化器 + cwd 迁移——空的 home 根不再是模型的「这个仓库」：

- `scenarioSchema` 增加 `workspace: 'demo-app' | 'monorepo'`（`eval/schema.ts`）；缺省表示子进程保持 home 根为 cwd（记忆召回型场景——seed 行的问题都指向其他项目与用户偏好，从不指向当前仓库）。
- `materializeWorkspace`（`eval/harness/workspace.ts`）从 `eval/harness/workspace-templates/` 复制被钉模板，`git init` 并以钉定身份（`dsh-eval <dsh-eval@localhost>`——与假子 home 写入的同一对，eval 进程自己的全局 git 配置永远不渗入 fixture 历史）做一次初始提交，然后写入恰好一个未跟踪文件（`docs/next-steps.md`），让对话里的「把这个改动提交了」有指称对象、`git status` 只有一项。以 `.git` 存在性幂等：plant 链的第二个 handle 复用第一个会话的目录树，包括首会话的编辑。
- `StartHarnessOptions.cwd`（`eval/boot.ts`，缺省仍是一次性 home）同时接进子进程与 `initialize` 握手；runner 对带 workspace 场景的两个 handle 都传物化路径。凭据 project-`.env` 隔离保持成立（workspace 在一次性 home 之内），且插件从会话头 cwd basename 推断的「当前项目名」变成稳定的 `demo-app`/`monorepo`，不再是随机的 `dsh-eval-run-XXXX`。
- core-v0 的 8 个 plant 行钉了模板——语料里全部仓库工作型对话：prog101/104/106/107/112/116/117 用 `demo-app`；prog111 用 `monorepo`（其对话在前提上绑定 packages/web、packages/core、turbo.json 与 core-先于-web 的构建顺序，单包 fixture 会变成新的前提证伪者）。

## 模板

两个模板都是 pnpm 专用（README、package.json、lock 文件陈述工具链，确认 prog101 的埋点前提；两个模板中没有任何文件与任何埋点事实矛盾）且零依赖——`pnpm install` 离线可解，没有任何场景期网络拉取能不确定地烧掉回合预算。

- `demo-app`——单包 TypeScript 服务。`src/cache.ts` 是写穿透的 `DetailCache`（prog116 的写路径失效前提，edge 键带构建戳）；`lib/util.ts` 携带一个 default export、由 `lib/index.ts` 转发（prog112 的「lib 禁 default export」规矩在 `lib/` 里有一个具体、可完成的修复目标）；`tests/integration/flaky.spec.mjs` 在文件内记录偶发超时历史（prog104 的 flaky 前提）；`.github/workflows/ci.yml` 先类型检查后测试（prog104 的 CI 见红前提）；`pnpm test` 是 `node --test` 显式列两个测试文件——零依赖即绿（spec 钉住这一点），因为 `node --test <目录>` 会把目录当模块执行（MODULE_NOT_FOUND），只有无参数形式才做文件发现。
- `monorepo`——pnpm workspace，`packages/core` 与 `packages/web` 各自经 `tsc -p tsconfig.json` 构建（prog111 的单包类型检查纪律，在 `packages/web/src/app.ts` 里复述）；根 `build` 脚本先 core 后 web（构建顺序前提）；`turbo.json` 声明 `"dependsOn": ["^build"]` 且无远程缓存键（「turborepo 远程缓存没开」的现场状态）。

## Testing

`tests/eval-workspace.spec.ts`（12 例）跨两个模板钉住物化器：模板保真 + 待提交文件、钉定身份下的单次提交史、恰好一项待提交且内容确定、跨 plant 链双 handle 的幂等、未知模板 fail loud、demo-app 自身套件跑绿（反循环性质），以及 schema 轴（接受、拒绝、语料 lint：workspace 行必是 plant 行）。全量通道：**961 passed | 6 skipped (967)**。端到端：物化了工作区的全量 core-v0 mock 跑（`/tmp/ab4-host-workspace-core.json`）对工作区改动前的 host 基线（`/tmp/ab2-host-core.json`）**逐场景 deterministic EQUAL、零场景错误**——fixture 在确定性层行为中性，同时 8 个场景的两次会话都在物化仓库上完整起落。

## Alternatives considered

- **给子进程做沙箱。** 本轮否：文件系统围栏需要 eval 进程并不拥有的容器/seccomp 机制，且围栏本身不给「这个仓库」提供指称对象——模型仍然在向一个不存在的仓库发问。物化工作区消除了逃逸的动机；若真模型在有指称对象的前提下仍然逃逸，沙箱保持为已记录的补充加固项。
- **在 JSONL 行内联逐场景的工作区文件。** 否：每行数 KB 的转义字符串、相同基础文件在 8 行里重复、模板每次微调都污染语料行 diff。版本化模板树（profile 模板的纪律）+ 每行一个薄钉定保持语料可读。
- **cwd 留在 home 根、对话文本里点名子目录。** 否：要改 8 行语料文本、harness 自己的文件（settings.yaml、storages/）仍在模型的根视图里，且形状偏离部署现实——真实 harness 以项目根为 cwd 运行，记忆插件读的就是 `session.header.cwd`。
- **依赖完备的 fixture（内置 tsc、装好 node_modules）。** 否：场景内的网络安装不确定且烧回合预算；零依赖保持物化离线确定。`pnpm build` 因缺全局 tsc 而失败是一个有界、可报告的结局——埋点前提是要记住的规矩，不是要验证的构建。

## Consequences

- 两个被阻塞的场景得到已记录的语料修复：反事实前提在仓库内自洽，仓库工作型对话有了有界目标。它们的重跑——以及仍待跑的 25/32 judged 基线——从此跑在工作区可解析的语料上。
- 埋点会话内的「当前项目」身份变为确定（cwd basename），注入排序与一切 project-scope 行为不再以随机临时目录名为键。
- 记录而非闭合的残留：prog112 的对话点名 `ui-kit`——一个 fixture 未物化的兄弟项目，模型可以报告其缺失但无法在其上循环；prog106 的「几个改动我分开提交」只会找到一个待提交文件而非多个。fixture 是前提自洽的，不是前提穷尽的：未来对话绑定了现有模板都不匹配的形状时，应新增模板，而不是在既有模板上叠 overlay。
- mock A/B 相等性覆盖物化工作区后的语料（对改动前基线 EQUAL），确定性通道跨本变更保持可比；noisy 通道未声明任何 workspace，未受影响。
