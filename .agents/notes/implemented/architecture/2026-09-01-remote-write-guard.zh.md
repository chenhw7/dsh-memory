# Agent Note: 远程写方法缺省拒绝,经部署级开关放行

Status: implemented

[English](2026-09-01-remote-write-guard.md) | 中文

## 问题

SEC-04 记录的通道完全敞开:remote 服务没有任何方法级守卫,传输栅栏放行的任何主机——包括 `trustedHosts` 配置过宽、放行整个局域网的部署——都能从同网段浏览器读写记忆库,而写入的每个字都会进入后续会话的系统提示词。信任边界只在传输层,且归档审计的缓解措施(「收紧 trustedHosts」)本仓库无法执行。

## 决策

remote 服务加一个部署级写开关,缺省拒绝:

- **`remoteWritesEnabled`** 挂在 `memory-remote` 的 schemastery Config 上,缺省 `false`。想要浏览器侧管理能力的部署在自己的 `cordis.patch.yml` row 里设置;缺省部署(无 config 行)经宿主同一套 standard-validate 接口解析出 `false`——有一条测试直接用 schema 校验 `undefined`,把 `.default(false)` 删掉 CI 就红。
- **七个写方法在触碰 store 之前守卫**:`add`、`update`、`removeEntry`、`pin`、`archive`、`suggestAdopt`、`suggestReject`。被拒的写返回该方法自身 wire 契约定义的形态——wire 有 error 字段的返回 `{ error: 'remote writes are disabled on this deployment' }`,没有的返回各自 no-op 形态(`{ removed: false }` / `{ found: false }` / `{ rejected: false }`)。读方法(`list`、`search`、`get`、`getRaw`、`projects`、`auditLog`、`health`、`suggestList`)不受影响。
- **客户端透传拒绝。** 管理 UI 的操作路径经既有 `actionError` 展示 wire error,禁用部署显示的是「远程写已禁用」,而不是之前误导性的「条目已经消失」。
- **写路径集成套件显式 opt-in**(组合里 `remoteWritesEnabled: true`),因为它的被测对象就是写路径本身。

## 曾考虑的替代方案

- **方法内做按请求 loopback 判定。** 做不到:`trustedHosts` 是宿主侧配置本仓库读不到,网关调用 `@Remote` 方法时不传请求头或来源信息——`local-only` 会是无法验证的空头承诺,所以开关如实命名为布尔。
- **拒绝时抛 transport 层错误。** 否决:wire 契约区分传输失败(`result.ok === false`)与被处理的拒绝;抛错会把部署的有意设置误判成故障,也破坏 remote 不抛异常的既有契约。
- **设置命名空间开关(热更新)。** 否决:这扇门限制的是安全面;热更新会诱使会话中途放松。组合时配置让变更留在部署文件里。

## 后果

- 缺省部署拒绝全部浏览器侧记忆写入;模型自己的工具(完全不经过 remote 服务)不受影响,agent 侧功能面不变。
- 想让管理 UI 完全可用的运维在部署里显式设 `remoteWritesEnabled: true`——一个记录在部署文件里的有意行为。
- 守卫是部署级而非按请求级:它区分不了 loopback 与 LAN 调用方。开启部署的残余暴露恰是 SEC-04 记录的内容;缓解手段是收紧 `trustedHosts`(宿主侧)与在不需要处保持开关关闭。
