# 经验教训：开发 dsh 插件客户端 UI

从 dsh-memory 插件的 UI 一致性调试中提炼的经验教训，面向所有开发 dsh 插件设置卡片或浏览器端 UI 的开发者。

---

## 1. 宿主不导出 UI 组件的运行时值

`@deepseek-ai/dsh-client-ui-settings-plugins` 将 `PluginCard`、`ValueField`、`CardForm`、`numberField`/`textField` 构建为**模块内部私有符号**。包的 `exports["./client"]` 只导出 `apply` 和 `inject`。`index.ts` 中的 `export type { PluginCardProps }` 声明是纯类型导出——用于跨包类型检查，不能在运行时 import。

你**无法** `import { PluginCard } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'`。npm 包不含 `src/`，所以 `"./src/*": "./src/*"` 这个 export 是死路径。构建产物 `lib/client.js` 把所有东西包在 `window.__ModuleLoader__.load({ factory })` 闭包里——组件是局部变量，外部无法访问。

**影响：** 每个贡献设置卡片的外部插件都必须从头复制卡片外壳、字段控件和 CSS。必须与宿主源码保持同步——以宿主的 `PluginCard.module.css` 和 `fields.module.css` 为准。

---

## 2. esbuild CJS 编译把 `const` 退化为 `var`——TDZ 保护消失

当 client bundle 用 esbuild 以 `format: 'cjs'` 构建时，每个模块级 `const` 都会变成 `var`。`var` 声明会**提升**到模块顶部，但**赋值不会提升**。这意味着：

```js
// 源码（TypeScript，受 TDZ 保护）：
const css = (inject(), cls)   // inject() 引用下面的 RULES
const RULES = `...`            // TDZ 会在 inject() 执行时抛错

// 编译后（CJS，无 TDZ）：
var css = (inject(), cls)      // inject() 现在就执行——RULES 是 undefined
var RULES = `...`             // 在 inject() 已经执行完之后才赋值
```

`inject()` 设置 `style.textContent = RULES`——但 `RULES` 是 `undefined`，所以 `<style>` 标签内容为空。**CSS 被静默地没有注入。** 卡片以浏览器默认样式渲染，与宿主卡片完全不同。不会抛出任何错误。

**规则：** 使用 esbuild CJS 输出时，被模块级副作用（如 `inject()`）引用的值必须在副作用调用**之前**定义。不要依赖 `const` 的 TDZ 来捕获顺序错误——编译步骤会移除这个安全网。

---

## 3. CSS 属性一致不够——要验证 CSS 是否真正注入了

调试时容易聚焦在 CSS 属性差异上（`width: 100%` 是否多余、`composes` vs 手动展开）。这些确实影响视觉一致性，但如果用户报告"整个卡片都不对"，CSS 很可能**根本没有注入**——这比属性差异强得多的信号。

**调试清单：**
1. 打开 DevTools → Elements → `<head>`。有没有带你的插件 `data-*` 属性的 `<style>` 标签？
2. 它的 `textContent` 是空的还是有内容？
3. 在构建产物 `lib/client/index.js` 中，搜索保存 CSS 字符串的变量和注入它的函数。文件中谁在前？

---

## 4. dsh client bundle 加载链路——`npm run build` 之后发生了什么

`dsh web` 服务器通过特定链路加载插件 client bundle。理解它对调试"改了代码但没变化"至关重要：

1. **启动扫描：** `ClientModuleRegistry` 扫描所有组合条目的 `dsh.client` 声明。对每个条目，读 `package.json` → `exports["./client"]` → 解析出 `lib/client/index.js`（或 export 指向的路径）。
2. **版本哈希：** 文件内容在**启动时**计算 SHA1 哈希（12 位十六进制）。这个 `rev` 注入到 HTML 的 `window.__DSH_BOOT__` 中——浏览器加载 `/plugins/<id>/client.js?rev=<hash>`。
3. **运行时服务：** 每次请求都从磁盘**实时读取**（`readFile`），返回 `cache-control: no-cache`。服务器不缓存文件内容。
4. **rev 在进程生命周期内固定。** 如果在 `dsh web` 运行时重新构建 bundle，磁盘上的文件变了，但 `window.__DSH_BOOT__` 中的 `rev` 仍是旧哈希。浏览器 URL 不变，可能使用缓存的响应。

**编辑插件 client 代码后的正确测试流程：**

```
npm run build          # 重新构建 lib/client/index.js
# 重启 dsh web          # 重新计算 rev → 新 URL → 浏览器获取新文件
# 强制刷新浏览器         # Ctrl+Shift+R — 绕过浏览器缓存
```

`file:` 安装方式（符号链接）不需要重新安装——符号链接指向你的工作树。npm 安装则需要重新发布或重新安装。

---

## 5. CSS Modules 的 `composes` 不能简单复制

宿主使用 CSS Modules 的 `composes: input` 在 `.inputInvalid` 中：
```css
.inputInvalid {
  composes: input;
  border-color: var(--dsw-alias-label-error);
}
```

`composes` 将 `input` 的所有属性合并到 `inputInvalid` 中，然后覆盖 `border-color`。由于外部插件无法使用 CSS Modules（没有宿主构建管线），必须**手动展开**组合属性：

```css
.dsm-c-input-invalid {
  /* 复制 .dsm-c-input 的每个属性 */
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-label-error);  /* 被覆盖 */
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
```

当宿主更新 `.input` 时，你的手动展开不会跟着变。以宿主源码为准，依赖升级时重新同步。

---

## 6. 行为语义要与宿主一致，不只是 CSS

宿主 `PluginCard` 在 `state.available === false` 时渲染 `null`，其中 `available = snapshot.status === 'ready'`。如果插件改用 `status === 'unavailable'` 判断，会在 `loading` 状态时渲染卡片——宿主不会。这会产生可见的闪烁和不一致行为。

**规则：** 阅读宿主组件源码，理解确切的状态转换，精确地镜像它们。CSS 一致但行为不一致，看起来仍然是错的。
