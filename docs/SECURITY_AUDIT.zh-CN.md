# 安全审计报告（docs/SECURITY_AUDIT.zh-CN.md）

- **审计对象**：`@chenhw7/dsh-memory`（Cairn）— DeepSeek Harness 长期记忆插件
- **审计分支**：`security-audit`（基于 `main` @ `0d2edad`）
- **审计日期**：2026-08-28
- **审计方法**：
  1. 多维度人工代码审计（命令执行、网络暴露、密钥、注入、文件处理、供应链/CI、第三方脚本、反序列化、异常代码九大类）；
  2. Mimosa 深度静态安全扫描交叉验证（密封产物，见 §4）。
- **证据边界**：Mimosa 扫描为 `static_only_no_runtime_execution`（纯静态，不运行目标项目）；本报告所有发现均经人工在源码中复核。

---

## 1. 执行摘要

| 结论 | 说明 |
|------|------|
| 🔴 **1 项高危** | 真实 API key 被硬编码在测试文件注释中并进入 git 历史（SEC-01）。**文件层面已修复；密钥吊销与历史清除需仓库所有者人工完成（见 §5）。** |
| 🟡 3 项低/低中风险 | CI 供应链加固（SEC-02/03）与本地目录卫生（SEC-07），**本次均已修复**。 |
| 🟠 2 项中高定级项（已修复） | `notesDir` 路径穿越（SEC-05，Mimosa HIGH）与测试端点 SSRF（SEC-09，L3 预提交钩子 HIGH）——均已在本次分支代码修复并通过测试。 |
| 🔵 2 项设计/潜在风险 | RPC 传输层信任依赖部署配置（SEC-04）、文档站 `innerHTML` 潜在 XSS 模式（SEC-06）。当前无可利用路径，给出加固建议。 |
| ✅ 其余类别干净 | 命令执行、SQL 注入、反序列化、安装生命周期脚本、第三方 JS、分析脚本等均未发现问题（见 §3）。 |

**最重要的一项行动**：立即在网关侧吊销/轮换泄漏的 key（SEC-01）。代码移除不会消除它已进入公开 git 历史的事实。

> 审计过程中的补充：提交本报告时，仓库配置的 Mimosa L3 预提交钩子拦截了提交，并新标记出 1 项 HIGH（测试端点 SSRF，SEC-09）。该项连同 SEC-05 的路径穿越已在本次分支一并修复并通过重扫。

---

## 2. 发现详情

### SEC-01 🔴 高危 · API key 与内部网关地址泄漏进 git 历史

- **位置**：`tests/judge-real-api.spec.ts` 文件头注释（原第 9–11 行）；引入提交 `3d24e26`
- **证据**：注释中以"环境变量示例"的形式写出了真实网关 URL（`REDACTED`，内部基础设施域名）与一个 32 位十六进制真实 API key（值已从本报告与代码中隐去，形如 `6cad804f…`）
- **影响**：本仓库公开托管于 GitHub（`chenhw7/dsh-memory`），该 key 自 `3d24e26` 起对所有人可见，可被自动化密钥扫描器（GitHub secret scanning、truffleHog 等）捕获并盗用配额或产生费用；网关域名同时泄露内部拓扑
- **状态**：
  - ✅ 文件层面已修复：真实值替换为 `<your-openai-compatible-gateway>` / `<your-api-key>` / `<your-model-id>` 占位符（本次分支提交）
  - ⚠️ **git 历史仍含该 key —— 必须人工处置，见 §5**

### SEC-02 🟠 低中 · GitHub Actions 按 tag 引用第三方 action

- **位置**：`.github/workflows/ci.yml:12-13`、`.github/workflows/publish.yml:21,31`（修复前）
- **影响**：`actions/checkout@v4` 等浮动 tag 可被上游重新指向恶意提交，代码将在你的 CI（含 publish 任务，持有 `NPM_TOKEN`）中执行
- **状态**：✅ 已修复 —— 两个 workflow 均改为按 commit SHA 固定并附版本注释：
  - `actions/checkout@11d5960a326750d5838078e36cf38b85af677262`（v4.4.0）
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`（v4.4.0）
  - （SHA 经 `git ls-remote` 对上游仓库实时核对，均为轻量 tag、直接指向 commit）

### SEC-03 🟡 低 · 发布任务未强制 lockfile

- **位置**：`.github/workflows/publish.yml:34`（修复前为 `npm install --no-audit --no-fund`；`ci.yml:16` 同）
- **影响**：发布到 npm 的那次构建不保证与 `package-lock.json` 一致，传递依赖可被静默替换
- **状态**：✅ 已修复 —— 两个 workflow 均改为 `npm ci --no-audit --no-fund`（`package-lock.json` 已被 git 跟踪，可正常执行）

### SEC-04 🔵 设计注意 · RPC 远程服务依赖宿主传输层信任

- **位置**：`src/remote/index.ts:13-20`（安全模型声明）、`:285-489`（`@Remote` 全量 CRUD：`add`/`update`/`removeEntry`/`pin`/`archive`）
- **现状**：服务自身无方法级鉴权，信任边界完全由宿主 `api-request-trust` 承担（放行 loopback / 部署派生 LAN 字面量 / `trustedHosts` 声明的主机，拒绝 DNS-rebinding 与跨站请求）。写路径受内容扫描器门禁（`src/store/index.ts` 各写入口）
- **风险**：若部署时 `trustedHosts` 配置过宽，同网段任意浏览器可读写记忆库（记忆内容会进入后续会话的系统提示词，构成提示注入持久化通道）
- **建议**：部署时收紧 `trustedHosts` 为实际需要的 UI 主机；如在不可信网络暴露宿主端口，考虑在方法层增加访问令牌。**本次未修改代码**（属宿主集成部署决策）

### SEC-05 🟡 低（已修复） · `notesDir` 路径拼接无包含校验（Mimosa 定级 HIGH）

- **位置**：`src/notes/index.ts:172`（`path.join(cwd, settings.notesDir)`）；`src/notes/settings.ts:41`（接受任意非空字符串，无规范化校验）
- **Mimosa 扫描**：该项为其唯一 HIGH 发现（CWE-22 路径穿越，见 §4）
- **人工可达性分析（初判低危）**：
  - 写入文件名固定（`CONVENTIONS.md` / `PITFALLS.md`），无工具调用/远程输入直达路径；
  - `notesDir` 来自操作员级 settings 命名空间，正常信任模型下模型与远程调用方均不可写；
  - 写入内容须经 `scanContent` 门禁（`src/notes/index.ts:134`）。
  - 因此原为**操作员配置错误时的纵深防御缺口**；但若宿主允许模型修改 settings，则升级为模型可控的任意目录写入链
- **状态**：✅ 已修复 —— 新增 `resolveNotesDir(cwd, notesDir)` 包含性校验（`src/notes/settings.ts`）：词法解析后必须落在项目根内，越界值（`../`、绝对路径指向他处）拒绝持久化并告警一次（log-once），提示词快照不受影响、仅跳过文件写入；`persist()` 接入该校验（`src/notes/index.ts`），并在 `tests/notes.spec.ts` 补充 5 个包含性单测。Mimosa HIGH 发现随之消除

### SEC-09 🟠 低（Mimosa L3 定级 HIGH）· 测试端点 SSRF：env 变量 URL 直达 `fetch`

- **位置**：`tests/judge-real-api.spec.ts`（`callJudge` 中 `` fetch(`${API_BASE}/chat/completions`) ``，`API_BASE` 来自 `JUDGE_API_BASE` 环境变量）；由预提交钩子的 L3 扫描标记，人工初判为低危（操作员本地设置的 env、仅手动触发、非服务端）
- **风险**：环境变量可指向回环/私网/云元数据地址（如 `169.254.169.254`），在被劫持或误配的 CI 环境中构成 SSRF 探测原语
- **状态**：✅ 已修复 —— 新增 `assertSafeEndpoint()` 守卫：`fetch` 前强制校验绝对 http(s) URL 且主机非回环/私网段/云元数据/本地域名，违规即抛错拒发

### SEC-06 🔵 潜在 · 文档站 `innerHTML` 使用（当前惰性）

- **位置**：`memory-architecture.html` 与 `memory-architecture.zh-CN.html` 各约 23 处（如 `:758`、`:817`、`:987`、`:1105`）
- **现状**：所有数据源为同脚本内硬编码数组；已确认页面及源码中**不存在** `location.search` / `location.hash` / `URLSearchParams`，无用户输入可抵达任何 sink —— 当前不构成 XSS
- **风险**：属潜在 DOM-XSS 模式，未来若有人加入 URL 参数驱动的内容即被引爆
- **建议**：新增交互时优先用 `textContent` / `createElement`；确需插值时对接收值做转义。**本次未修改页面**（纯静态站，无现实威胁）

### SEC-07 🟢 卫生 · `.mimosa/` 本地目录未被 git 忽略

- **位置**：仓库根 `.mimosa/`（约 80 个扫描器状态/baseline 文件，未跟踪）
- **影响**：一次 `git add -A` 即会把机器本地状态误提交
- **状态**：✅ 已修复 —— `.gitignore` 追加 `.mimosa/`

### SEC-08 ⚪ 信息 · Google Fonts 样式表无 SRI

- **位置**：`index.html:22-24`、`memory-architecture.html:22-24`、`memory-architecture.zh-CN.html:22-24`
- **现状**：CSS 由 CDN 动态下发，技术上无法加 `integrity`（SRI 对该端点不适用）；页面**零外部 `<script>`、零 iframe、零分析脚本**，攻击面仅限 CSS 注入
- **建议**：如需彻底消除外部依赖，可自托管字体文件。**本次未修改**

---

## 3. 排查过且未发现问题的类别

| 类别 | 结论 |
|------|------|
| 命令/进程执行 | 无 `child_process`/`exec`/`spawn`/`eval`/`new Function`/`shell: true`（仅正则 `.exec()`） |
| SQL / 命令注入 | 无 SQL；存储为 JSON 文件（`@deepseek-ai/dsh-storage-json`） |
| 不安全反序列化 | 无 `yaml.load`/`pickle`；`JSON.parse` 结果均无危险 sink |
| npm 生命周期脚本 | 无 preinstall/postinstall（`prepare` 为 `echo skip`） |
| CI 不信任输入模式 | 无 `pull_request_target`、无不信任 checkout；CI 密钥均走 `secrets.NPM_TOKEN` |
| 第三方前端脚本 | 零外部 `<script src>`、零 iframe、零分析/遥测；JSON-LD 为静态硬编码 |
| 恶意/混淆代码 | 无 base64 大块、无混淆、无 phone-home（唯一出站调用为环境变量门禁的 judge 测试） |
| 提示注入（写入侧） | 所有记忆写入路径均过 `scanContent` 门禁（含 `src/review/extract.ts` 提取路径），残留风险为正则绕过，属设计固有 |

> 说明：`src/scanner.ts` 与 `tests/scanner.spec.ts` 中出现的 `sk-`/`ghp_`/`AKIA`/`PRIVATE KEY` 等模式是插件自身防御扫描器的**检测规则与测试夹具**，非泄漏。

---

## 4. Mimosa 深度扫描交叉验证（密封产物）

- **Scan ID**：`scan-2026-08-28T03-31-00.840Z-d1097aba17e4`
- **Seal**：`sha256:3324097df3e857d25c04b1aa92e4eeb1f7c06f97e2d3a28bf46d3281a4ad4ebe`
- **产物目录**：`C:\Users\xpeng\.mimosa\security-scans\project-7b0db1ee14cdb6c55f846e63\scan-2026-08-28T03-31-00.840Z-d1097aba17e4`
- **证据边界**：`static_only_no_runtime_execution`（静态分析，未运行项目代码）

**覆盖情况**：选定并解析 67 个源文件（无截断、无解析失败）；路径分析覆盖 1566 个函数、1959 条调用边；威胁模型阶段未观测到入口点/主体/授权面（静态口径）。运行状态 `inconclusive`，声明覆盖缺口：调用图存在动态派发导致的跨文件可达性不完整。

**依赖风险摘要**：扫描 245 个包，离线告警库匹配 **0** 个包、**0** 条安全通告。

**Finding（1 项 HIGH）**：

> `path-traversal`（CWE-22）@ `src/notes/index.ts:172` —— "动态路径片段经 path.join/resolve 后进入文件读写，未见根目录边界或文件名白名单校验；`../` 可越出受限目录。"

与本次人工审计 SEC-05 为同一发现。Mimosa 按漏洞类别定级 HIGH；结合人工可达性分析（固定文件名、操作员级配置来源、扫描器内容门禁），初判实际风险为低，且现已在本次分支修复（含包含性校验与单测，见 SEC-05 状态）。

**互补性说明**：Mimosa 静态扫描未覆盖注释中的凭据泄漏（SEC-01）与 CI 工作流配置问题（SEC-02/03）——这两类由人工审计发现；其 L3 预提交钩子则额外标记出测试端点 SSRF（SEC-09）。两种方法互补。

**修复后复核扫描（密封回执）**：

- Scan ID：`scan-2026-08-28T03-49-37.687Z-ee33668e5aa5`
- Seal：`sha256:b75645cdb3c7a6ba1bf2f2f0971296076cb6b48d28d922c3475d26cfb63a6f5d`
- 结果：**0 项发现**（初扫的 1 项 HIGH 路径穿越已消除）；243 个依赖包、0 条安全通告匹配
- 说明：本仓库预提交钩子的 L3 快扫曾以"扫描结论不完整（library_source 上限、调用图部分）"提示，属静态分析规模限制；上述密封深度扫描为权威回执。静态分析不等于运行时验证，不构成"项目完全安全"的断言。

---

## 5. 需仓库所有者人工完成的处置

### 5.1 立即吊销/轮换泄漏的 key（SEC-01，最高优先级）

1. 登录 fuyao 网关管理侧，**吊销** key `6cad804f…`（完整值见本地 git 历史或网关控制台）；
2. 签发新 key，仅存放于本地未跟踪的 `.env`（`.gitignore` 已覆盖 `.env` / `.env.*`）；
3. 运行该测试时改用 `JUDGE_API_KEY=$(grep JUDGE_API_KEY .env | cut -d= -f2)` 等方式注入，勿再写回文件。

### 5.2 清除 git 历史中的 key（吊销完成后可选，但建议执行）

吊销后 key 已无害，历史清除仅为消除内部域名等信息残留。如需执行：

```bash
# 安装 git-filter-repo 后，在全新克隆上执行（会重写全部历史并移除 remote）
pip install git-filter-repo
git clone https://github.com/chenhw7/dsh-memory.git dsh-memory-rewrite && cd dsh-memory-rewrite
printf 'REDACTED==>REDACTED\n' > /tmp/replacements.txt
printf 'REDACTED==>REDACTED\n' >> /tmp/replacements.txt
git filter-repo --replace-text /tmp/replacements.txt --force
git remote add origin https://github.com/chenhw7/dsh-memory.git
git push origin --force --all && git push origin --force --tags
```

注意事项：重写后所有提交哈希变化，需通知所有协作者重新克隆；GitHub 上旧 PR/缓存的提交视图可通过联系 GitHub Support 申请清除。

---

## 6. 本次分支已实施的修复清单

| # | 修复 | 文件 |
|---|------|------|
| 1 | 泄漏 key 与内部网关 URL 替换为占位符 | `tests/judge-real-api.spec.ts` |
| 2 | GitHub Actions 改为 commit SHA 固定（v4.4.0） | `.github/workflows/ci.yml`、`.github/workflows/publish.yml` |
| 3 | `npm install` → `npm ci`（强制 lockfile） | 同上两个 workflow |
| 4 | `.gitignore` 追加 `.mimosa/` | `.gitignore` |
| 5 | 本安全审计报告入库 | `docs/SECURITY_AUDIT.zh-CN.md` |
| 6 | `notesDir` 包含性校验：新增 `resolveNotesDir()`（越界拒绝持久化 + log-once 告警）并接入 `persist()` | `src/notes/settings.ts`、`src/notes/index.ts` |
| 7 | `resolveNotesDir` 包含性行为的 5 个单元测试 | `tests/notes.spec.ts` |
| 8 | 测试端点 SSRF 守卫：`fetch` 前校验 http(s) 绝对 URL + 非回环/私网/元数据主机 | `tests/judge-real-api.spec.ts` |

未修改代码的建议项（SEC-04/06/08）请按各节建议单独评审实施。
