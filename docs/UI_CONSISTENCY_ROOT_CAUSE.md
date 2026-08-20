# UI 一致性问题根因分析

## 问题

Memory 插件在设置页（Settings → Plugins → Plugin configuration）中的卡片 UI 与宿主内置卡片（Shell、Agent loop、Web search）的 UI 不一致。

## 根因

### 根因 0（最关键）：CSS 注入顺序 bug 导致样式完全缺失

`card-styles.ts` 中 `const RULES` 定义在 `export const css = (inject(), cls)` **之后**。`inject()` 函数在执行时引用 `RULES`，但此时 `RULES` 尚未赋值。

在 TypeScript 源码中用 `const` 有 TDZ（暂时性死区）保护，理论上会在 `inject()` 执行时报错。但 esbuild 编译成 CJS 后 `const` 变成了 `var`——声明被提升到函数顶部，赋值不提升。因此 `inject()` 执行时 `RULES` 为 `undefined`，`style.textContent = undefined` 注入了一个空的 `<style>` 标签。

**结果是 Memory 卡片的 CSS 完全没有注入到页面中**，卡片以浏览器默认样式渲染，与宿主卡片（Shell / Agent loop / Web search）的视觉完全不同。这才是用户看到的"整个卡片样式都不一样"的真正原因。

修复：将 `RULES` 的定义移到 `inject()` 函数和 `cls` 映射之前。

### 根因 1（结构性根因）：宿主不导出 UI 组件运行时值，外部插件被迫重新实现

宿主 `@deepseek-ai/dsh-client-ui-settings-plugins` 的 `exports["./client"]` 构建产物只导出了两个东西：

```js
exports.apply = apply;
exports.inject = inject;
```

宿主三个内置卡片共享的 UI 组件——`PluginCard`（卡片外壳）、`ValueField`/`SecretField`（字段控件）、`CardForm`（表单状态管理）——全部是模块内部私有，没有通过 `exports` 导出。`index.ts` 里的 `export type { PluginCardProps }` 等声明都是**类型导出**（`export type`），不是值导出。

因此外部插件**无法** `import { PluginCard } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'`——类型可以引用，但运行时拿不到组件函数。这就是为什么本插件被迫在 `MemoryPluginCard.tsx` 和 `card-styles.ts` 中手动重新实现一套平行组件和 CSS。

这是 UI 不一致的**结构性根源**：宿主的共享组件和设计系统没有面向外部插件开放，外部插件只能手动复制，而复制不可能与源同步。

### 根因 2（直接根因）：手动复制的 CSS 与宿主不完全一致

本插件的 `card-styles.ts` 声称是宿主 `PluginCard.module.css` + `fields.module.css` 的 "line-by-line port"，但实际存在以下差异：

| 差异点 | 宿主 | 本插件 |
|---|---|---|
| `.input` 宽度 | 无 `width`/`box-sizing` 声明 | 加了 `width: 100%; box-sizing: border-box` |
| `.inputInvalid` | `composes: input`（CSS Modules 组合，只覆盖 border-color） | 手动复制整条 `.input` 规则，重复所有属性 |
| `.badgeMuted` | 存在（`SecretField` 使用） | 缺失（本插件未用 `SecretField` 所以不显，但属于不完整复制） |
| CSS 注入机制 | 构建管线处理为 minified 字符串，以 `data-plugin-css` 属性去重 | 裸 CSS 字符串注入 `<style>` 标签，以 `injected` 布尔变量去重 |
| 类名 | 哈希前缀 scoped 类名（如 `jVY7La_card`） | 全局类名 `dsm-c-card` |

这些差异意味着即使视觉上"看起来差不多"，在宿主更新 CSS 后本插件不会跟着变，两条线必然漂移。

### 根因 3（直接根因）：组件结构和状态管理模型与宿主不同

**组件结构差异：**

- 本插件多了 `SelectField`、`CheckboxField`、`TextareaField` 三个宿主没有的控件类型，全部手写
- 宿主用 `clsx` 做条件 class 拼接，本插件用模板字符串
- 宿主 `PluginCard` 接收 `children` 作为参数，在 footer 之前渲染；本插件把 loading 状态和 fields 直接写在 body 内，loading 逻辑不同（宿主无 loading 状态）

**表单状态管理差异：**

| | 宿主 `CardForm` | 本插件 |
|---|---|---|
| 状态模型 | `CardForm` 类 + `SnapshotStore` 发布，`shell()`/`field()`/`actions()` 精确投影 | `useState` + `JSON.stringify` 做 dirty 检测 |
| dirty 判定 | `plan.length > 0`（有 staged write） | `JSON.stringify(draft) !== JSON.stringify({...DEFAULTS, ...committed})` |
| available 判定 | `status === 'ready'` | `status !== 'unavailable'`（用 unavailable 反向判断） |
| save 写入 | 逐字段 `scope.set`/`scope.unset`，读回验证 | 逐字段 `props.set`/`props.unset`，Promise.all 批量 |
| draft 管理 | staged edit map，按字段记录 text/clear | 单一 draft 对象，整体替换 |

## 影响

- **视觉不一致**：卡片边框、输入框宽度、invalid 状态样式等与宿主卡片有细微差异
- **行为不一致**：dirty 检测、save 流程、状态映射逻辑与宿主不同
- **维护负担**：宿主 UI 组件更新后本插件不会自动同步，需要手动跟踪
- **CSS 作用域风险**：全局类名 `dsm-c-*` 可能与宿主或其他插件冲突

## 涉及文件

| 文件 | 角色 |
|---|---|
| `src/client/MemoryPluginCard.tsx` | 手动复制的卡片组件 + 字段控件 |
| `src/client/card-styles.ts` | 手动复制的 CSS（注入为 `<style>` 标签） |
| `src/client/index.ts` | 插件客户端入口，注册 slot |
| `src/client/locales.ts` | 本地化字典 |

宿主对照文件（`deepseek-harness` 仓库）：

| 文件 | 角色 |
|---|---|
| `packages/client/ui-settings-plugins/src/client/PluginCard.tsx` | 卡片外壳组件（未导出） |
| `packages/client/ui-settings-plugins/src/client/PluginCard.module.css` | 卡片外壳 CSS（CSS Module） |
| `packages/client/ui-settings-plugins/src/client/fields.tsx` | 字段控件（未导出） |
| `packages/client/ui-settings-plugins/src/client/fields.module.css` | 字段 CSS（CSS Module） |
| `packages/client/ui-settings-plugins/src/client/card-form.ts` | 表单状态管理（未导出） |
| `packages/client/ui-settings-plugins/src/client/AgentLoopCard.tsx` | 示例：宿主内置卡片如何使用共享组件 |
| `packages/client/ui-settings-plugins/src/client/index.ts` | 只导出 `apply` + `inject` + 类型 |

## 结论

核心根因是**宿主没有将 UI 组件作为运行时值导出**，外部插件无法复用。这是架构层面的缺陷——宿主的设置插件系统设计了 `settings.plugin.item` slot 机制让外部插件注册卡片，但没有提供卡片组件库供外部插件使用，导致每个外部插件都必须重新实现一套 UI。

---

## 教训

### 教训 1：esbuild 编译 CJS 时 `const` 退化为 `var`，TDZ 保护消失

`card-styles.ts` 中 `const RULES` 定义在 `export const css = (inject(), cls)` 之后。在 TypeScript 源码中，`const` 有 TDZ（暂时性死区）保护——在 `RULES` 赋值前访问它会抛 `ReferenceError`。但本插件的 client bundle 通过 esbuild 编译为 CJS 格式（`scripts/build-client.cjs`），esbuild 将 `const` 转为 `var`。`var` 的声明会被提升到函数顶部，但**赋值不会提升**。因此 `inject()` 执行时 `RULES` 为 `undefined`，`style.textContent = undefined` 注入了空的 `<style>` 标签。

**规则：不要依赖 TDZ 保证执行顺序。** 当代码会被编译为 CJS（或经过任何将 `const` 退化为 `var` 的变换）时，变量必须在其被引用的位置之前完成赋值。模块顶层的副作用调用（如 `inject()`）尤其危险——它们在模块加载时立即执行，此时后续的 `var` 赋值尚未发生。

**修复方式：** 将 `RULES` 的定义移到 `inject()` 函数和 `cls` 映射之前，确保 `inject()` 执行时 `RULES` 已赋值。

### 教训 2：CSS 不生效时，先确认 CSS 是否被注入，再检查 CSS 内容

调试 UI 不一致时，最初的注意力集中在 CSS 属性差异上（`width: 100%`、`box-sizing`、`composes` 等）。这些差异确实存在，但它们只会导致**细微的**视觉差异。用户报告的是"整个卡片样式都不一样"——这暗示 CSS **完全缺失**，而非属性偏差。

当 CSS 完全缺失时，组件以浏览器默认样式渲染，与宿主的精心设计差距巨大。这个信号比"某个属性值不同"强得多，应该优先排查 CSS 注入链路是否正常工作。

**排查方法：** 在浏览器 DevTools 中检查 `<head>` 里是否存在插件注入的 `<style>` 标签，以及其 `textContent` 是否为空。如果在构建产物（`lib/client/index.js`）中搜索 `var RULES` 和 `var css` 的位置，发现 `RULES` 在 `css`（调用 `inject()`）之后赋值，就能定位到顺序 bug。

### 教训 3：不要只读源码分析根因，要验证运行时实际行为

前两轮分析（根因 1-3）完全基于源码阅读，得出的结论是"CSS 属性差异"和"组件结构差异"。这些结论在源码层面是对的，但**不是用户看到的问题的原因**。真正的原因（CSS 注入顺序 bug）只有在检查运行时构建产物的执行顺序时才会发现。

**规则：** 源码分析能发现潜在问题，但用户报告的问题必须通过运行时验证来定位。具体到这个案例：
- 源码分析发现 `width: 100%` 多余 → 修正了，但用户看不到变化
- 运行时验证（检查 `lib/client/index.js` 中 `var RULES` 和 `var css` 的位置）才发现 `RULES` 在 `inject()` 执行时为 `undefined`

### 教训 4：dsh 插件 client bundle 的加载链路

排查"修改了代码但浏览器没有变化"时，需要理解 dsh 的 client module 加载链路：

1. `dsh web` 启动时，`ClientModuleRegistry` 扫描所有 `dsh.client` 声明的插件包
2. 从每个插件的 `package.json` `exports["./client"]` 解析出 `lib/client/index.js` 路径
3. 读取文件内容计算 SHA1 hash（12 位），作为 `rev` 注入到 HTML 的 `window.__DSH_BOOT__` 中
4. 浏览器加载 `/plugins/<id>/client.js?rev=<hash>`，服务器实时从磁盘读取文件返回（`cache-control: no-cache`）
5. **`rev` 在进程启动时固定**，运行中文件变了 `rev` 不会更新——需要重启 dsh 进程才能让浏览器加载新 URL

因此，修改插件 client 代码后的正确测试流程是：`npm run build` → 重启 `dsh web` → 强制刷新浏览器。由于 `file:` 安装方式是符号链接，不需要重新安装插件。
