# Agent Note: client 源码获得自己的类型门禁

Status: implemented

[English](2026-09-01-client-typecheck-gate.md) | 中文

## 问题

`tsconfig.json` 把 `src/client` 排除在宿主 tsc 程序之外,而其他任何东西都不对它做类型检查:client 唯一的编译器是 esbuild 打包器,它擦除类型而不检查。设置卡片或记忆 section 里的一个类型错误会以静默破坏(或碰巧能跑)的运行时代码形态发布。这个缺口是真实的而非假设——`getRaw` RPC 落地时声明了线上类型却没接 client 侧 face,只有对 `src/client` 跑类型检查才能抓住它。[quality-gates note](2026-08-31-quality-gates.zh.md) 曾把该豁免记录为架构决策,因此关闭这个门禁必须在同一次变更里更新那份记录。

## 决策

一个专用的 client 类型检查程序,接进既有 build 车道:

- **`tsconfig.client.json`**——继承宿主配置,覆盖为 `noEmit` + `composite: false`,设 `jsx: "react-jsx"`(automatic runtime,与 `build-client.cjs` 和 `vitest.config.ts` 一致),lib 换成 `es2023 + dom + dom.iterable`(client 代码跑在浏览器),`types` 去掉 Node。
- **宿主包类型面。** client 从 `dsh-client-ui-slots`、`-ui-primitives`、`-ui-settings/client`、`-ui-settings-plugins/client`、`-client-locale/client`、`-ui-renderer/client`(`ctx.slots` merge)与 `-client-connection/client`(`connection/reset` 事件 merge)引入类型。它们全部是 devDependency,钉在与运行时 peer `@deepseek-ai/dsh-client-store` 相同的 `0.1.2-alpha` 版本线上,且发布 tarball 携带 `lib/types/`,因此所有 `paths` 条目都解析到本包 node_modules 内——门禁不依赖 harness checkout。client 打包仍把它们当作 external 经注入的 `require` 在运行时解析;这些 devDependency 实际上只提供类型,不进入发布物。
- **`@types/react@18.3.31`** 作为 devDependency,与 react 18.3.x 运行时匹配。
- **build 接线。** `npm run build` = `tsc (host)` → `tsc -p tsconfig.client.json` → `fix-imports` → `build-client`。门禁在打包之前运行,client 类型错误让 build 失败而不是发布出去。

决定"先清存量、后接线"的摸底数据:环境补齐后(`@types/react` + paths 映射),原始 409 个错误收敛为 12 个真实错误——323 个是 JSX 运行时缺失,11 个是宿主声明缺失。12 个全部在本次修复:`settings.memory` locale namespace 声明(本 bundle 自有,键域锚定自己的字典)、`ctx.slots` Context merge 引入、client RPC face 缺失的 `getRaw`、`FieldSpec` locale 键收窄到字典键域、以及建议拒绝路径上的一处 exactOptionalPropertyTypes 签名修复。

## 曾考虑的替代方案

- **先接线、后清存量。** 否决:红色 build 会阻塞其余全部轨道;实测存量使"修 12 个再接线"成为更便宜的顺序。
- **从本仓库为宿主包发布类型声明。** 否决:声明归属于包所在的 harness workspace;在本仓库复制会漂移。
- **把 client 检查并入宿主 tsconfig。** 否决:两个程序需要不同的 jsx/lib/types 设置;强行合一会削弱宿主程序对 Node 的准确检查。

## 后果

- client 类型错误与宿主错误一样,会让 `npm run build` 失败,进而让 CI 失败。
- 宿主包 devDependencies 钉在已安装 peer 的版本线上;升级 harness peer(`HOST_CONTRACT` §9 核对清单)时必须在同一次变更里同步移动这些钉子,否则门禁会用落后于运行时的类型检查 client。
- `AGENTS.md` 的 client 条目与 [quality-gates note](2026-08-31-quality-gates.zh.md) 现在把该门禁描述为已强制,而非豁免。
