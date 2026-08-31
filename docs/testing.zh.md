# 测试策略

[English](testing.md) | 中文

本仓库如何测试,以及让"绿灯有意义"的规则。命令见根 [AGENTS.md](../AGENTS.md);理由由相应 Agent Notes 与文档持有。

## 测试分层

- **单元测试**(`npm run test`):vitest 跑 `tests/` 下的规格,含 `tests/integration/` 中的集成规格(composition 与宿主契约 smoke)。测试在作用域与命名上贴近被测代码;[vitest 配置](../vitest.config.ts)用 automatic JSX runtime 编译 client 源码,使 `tests/*.spec.tsx` 能在 `node` 环境驱动真实的 `src/client` 组件树。
- **真实 API**(`tests/judge-real-api.spec.ts`):唯一调用真实模型的规格。无 `DEEPSEEK_API_KEY` 时经 `describe.skipIf` 自动跳过,本地与 CI 均保持绿灯。[测试技能](../.agents/skills/dsh-ci-test-reliability/SKILL.md)规定其重试只在这个外部边界内有效。
- **金标语料**:`tests/fixtures/` 保存入库数据集——去重数据集、提取金标、扫描器语料。`tests/recall-golden.spec.ts` 钉住 [INDEX_MODE_EVALUATION.zh.md](INDEX_MODE_EVALUATION.zh.md) 实测的注入模式对比;有意改变金标数值的变更在同一次变更中更新夹具与该评估文档。
- **构建门禁**(`npm run build`):对 `src/` 跑 `tsc` 加 esbuild client 打包。TypeScript 就是 typecheck 车道;没有独立的覆盖率、lint 或快照车道。CI(`.github/workflows/publish.yml`)在版本 tag 上跑 `npm ci && npm publish --provenance`,发布前执行 `prepublishOnly`(`build && test`)——测试不过则发布被阻断,tag/版本一致性检查最先执行。

## 规格如何执行

Vitest 以 worker 线程并发运行规格文件,CI 与本地共用同一台主机。进程隔离不隔离主机端口、可预测文件路径、环境变量或全局模块状态。任何获取资源或修改全局状态的规格,其分配、恢复、同步、超时预算与清理规则由 [dsh-ci-test-reliability](../.agents/skills/dsh-ci-test-reliability/SKILL.md) 负责。

## 优先用真实实现而非 mock

只 mock 昂贵或非确定性的边界:review 管线背后的 LLM adapter 与远程存储传输。这些边界下游全部跑真实代码——JSON store、BM25 召回、去重、settings schema 都解析到真实领域代码。client 套件直接驱动已发布的 `@deepseek-ai/dsh-client-store`,不打桩。手搓替身只能证明桥接在搬运字节,不能证明交付代码按断言行事。

## 验证世界,而非自述

断言要重新读 store 文件、重跑扫描、或在外部检查渲染出的段落;对组件自身日志的关键词探测会让坏管线蒙混过关。对提取与 review 流程,断言持久化的 store 状态,而不是模型的叙述。测试拥有自己的资源:在测试内创建,在 `afterEach` 释放(失败时也一样),绝不把 `tests/fixtures/` 的条目当跨规格的可写状态共享。

## 密钥策略

真实 API 测试从环境读取 `DEEPSEEK_API_KEY`。绝不提交凭据;绝不在诊断输出里打印密钥。自动跳过让无密钥的贡献者不被阻塞;它不是成本信号。无密钥运行只证明管道通;只有带密钥运行才能证明 judge 提示与评分对真实模型有效——凡触及 review 管线的变更,发布前都要跑一次。

## 行为变更何时需要证据

每个行为变更都附带"对它的回归会失败"的最窄测试,按 [dsh-pre-push-checks](../.agents/skills/dsh-pre-push-checks/SKILL.md) 选取:召回排序变更更新 `tests/bm25.spec.ts` 或 recall 金标;提取提示或 judge 规则变更更新 `tests/extract.spec.ts` 或 `tests/confirm-extraction.spec.ts` 并补一次带密钥运行;settings 字段变更更新 `tests/model-catalog.spec.ts` 或 `tests/settings-live.spec.ts`;client 卡片变更经真实组件的 `*.spec.tsx` 驱动验证。何时必须跑全量套件,由发布手册([RELEASING.zh.md](RELEASING.zh.md))决定。
