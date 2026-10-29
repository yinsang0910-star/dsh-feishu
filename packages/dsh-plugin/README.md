# DSH 插件机制研究 + 最小骨架

本目录是**研究产物 + 可加载的最小骨架**，不含业务功能。所有结论都标了依据（文件 + 行号）；
凡是我没能验证的，一律写「未验证」，不猜。

> 调研环境（2026-10-30，只读）
> - DSH 运行时版本：`0.2.0-rc.2`（`…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-app-boot\package.json` 的 `version`）
> - `DSH_HOME` = `C:\Users\苏元洛\.dsh`；日常 profile = `profiles\desktop`
> - 本文用简写：
>   - `PURGE` = `C:\Users\苏元洛\.dsh\plugins\dsh-purge`（第三方完整样本）
>   - `NM` = `C:\Users\苏元洛\.dsh\profiles\node_modules\@deepseek-ai`（官方 ~200 个包）
>   - `APPBOOT` = `NM\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`（注意它在 `dsh` 自己的 node_modules 里，不在顶层 `NM`）

---

## 0. 六个问题的一句话答案（速查）

| # | 问题 | 结论 | 关键依据 |
|---|---|---|---|
| 1 | 最小结构 | = `package.json`（`type`/`main`/`exports` + `dsh.bundle.patch`）+ 一个 patch yml + 一个 ESM 入口导出 `name`/`inject`/`apply`；装上不加 frontend 也能跑 | `PURGE\package.json:5-17,64-67`；`APPBOOT:61-118` |
| 2 | 服务端 / 客户端怎么分 | 同一包两个入口：`main`/`exports["."]` 是 Node 侧 Cordis 插件；`dsh.client.platform="web"` + `exports["./client"]` 是浏览器 CJS factory bundle | `PURGE\package.json:6,11,68-77`；`NM\dsh-package-manifest\lib\types\types.d.ts:76-79` |
| 3 | 怎么注册设置页 | 浏览器侧 `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, 组件))`，槽位由 `ui-settings-general` 声明 | `NM\dsh-client-ui-settings\lib\types\client\contract\slots.d.ts:73-77`；`NM\dsh-client-ui-settings-general\lib\client.js:1136,1171-1180` |
| 4 | 怎么注册后端 HTTP 端点 | `ctx.webServer.register({kind:'exact', path, handler})`，挂在宿主已有的 HTTP server 上（不是新起端口） | `NM\dsh-host-webserver\lib\types\index.d.ts:33-38,100-106`；`PURGE\lib\redteam\ui.js:1079-1082` |
| 5 | `inject: [systemPrompt, tools]` 是什么 | Cordis 的**服务就绪门槛**：列出的服务全部出现后才调 `apply()`；列了不存在的服务 → 插件永远 pending（`dsh-purge` 注释说宿主会以退出码 1 结束） | `cordis\README.md`（inject 段）；`PURGE\lib\index.js:39-43` |
| 6 | 最小可工作插件 | 本目录：`src/index.ts` 113 行 + `client.js` 84 行 = 197 行，零前端构建；离线冒烟 14/14 通过 | 见 §7 |

---

## 1. Q1 —— 一个 DSH 插件的最小结构

### 1.1 必需件（三件套）

```
<package>/
├─ package.json         # 身份 + dsh 声明（决定"怎么被加载"）
├─ cordis.patch.yml     # bundle patch：把本插件的一行插进 profile 的 entry 树
└─ <入口>.js / .ts      # ESM，导出 name / inject / apply（或 default 三者打包）
```

`PURGE` 的实例（文件在 `PURGE\package.json`）：

| 行 | 字段 | 值 | 作用 |
|---|---|---|---|
| 5 | `type` | `module` | 入口按 ESM 解析（`applyEntryPatches` 之后 Loader 做动态 `import`） |
| 6 | `main` | `lib/index.js` | Node 侧插件入口 |
| 11 | `exports["./client"]` | `./client.js` | 浏览器侧 bundle（见 Q2） |
| 12-15 | `exports["./redteam*"]` | 子路径入口 | 供 patch 里写 `name: 'dsh-purge/redteam'`，一行一个子插件 |
| 64-67 | `dsh.bundle.patch` | `./cordis.patch.yml` | **被 profile 当作 bundle 层时必须**：launcher 读这个字段找 patch |
| 68-77 | `dsh.client` | `{platform:'web', inject:[…]}` | 声明浏览器半侧 |
| 88-90 | `peerDependencies` | `@deepseek-ai/cordis: ^4.0.1` | 只有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 开头的 peer 会走版本闸（见 1.4） |
| 94 | `dshTarget` | `0.2.0-rc.2` | 在 `APPBOOT` 和 `plugin-inventory` 里**没找到读取点** → 疑似该包自定义字段，官方读的是 `peerDependencies` + `dsh.engines` |

> 结论：`main` + `exports` 决定入口，`dsh.bundle.patch` 决定"作为 bundle 安装时插哪些行"，
> 两者都不是可选的（除非你只手动往 profile 的 patch 里写行、不把包登记成 bundle）。

### 1.2 `cordis.patch.yml` 的真实语义

权威实现是 `APPBOOT:61-118` 的 `applyEntryPatches(data, patches, warn)`。它是**唯一**的 patch 语义来源
（`dsh --dump-config` 也共用它，注释见 `APPBOOT:48-53`）。规则逐条：

1. 顶层是 YAML **数组**，一项一个 patch 对象。
2. 含 `insert` 键时（`APPBOOT:74`）：
   - **带 `id`**：把 `insert` 数组 `push` 进该 id 那一行的 `config`；该行不是 group 就 warn 跳过（`APPBOOT:75-86`）。
   - **不带 `id`**：直接 `data.push(...insert)`，插到 entry 列表根部（`APPBOOT:87`）。`PURGE` 就是这种（`PURGE\cordis.patch.yml:36`）。
   - 插入的行会立刻建索引，所以同一份 patch 里后面的 patch 可以引用前面刚插入的行（`APPBOOT:54-55`）。
3. 不含 `insert` 时（`APPBOOT:92-108`）：`id` 必填；按 `id` 找行，若同时写了 `name` 还要校验 name 一致
   （不一致 → warn + 跳过），然后**逐键覆盖**：`disabled` / `config` / `inject` 都只是普通键覆盖。
   典型用法：`PURGE\cordis.patch.yml:7-31`（禁用别人的行、改别人的 config）。
4. 匹配不到任何行的 patch **只 warn**，不会让启动失败（`APPBOOT:96-98`）。

`PURGE` 那份 patch 的三个形态都能对上：

```yaml
- id: redteam-store            # 形态 2：按 id 关掉别人的行
  name: dsh-redteam-store
  disabled: true               #   （PURGE\cordis.patch.yml:7-9）

- id: system-prompt            # 形态 2：按 id 覆盖 config
  config: { includeHarnessIdentity: false, ... }   # （:27-31）

- id: dsh-purge                # 形态 2：按 id 覆盖 inject
  inject: [systemPrompt, tools]                    # （:33-34）

- insert:                      # 形态 1（无 id）：插到根
    - id: dsh-purge
      name: 'dsh-purge'        # 这里 name 是"模块说明符"，Loader 拿它 import
      config: { ... }          # （:36-56）
```

`insert` 块和 `inject:` 的关系：**`insert[].inject` 是给这一行 entry 的 inject**（Loader 的 entry 选项，
见 `cordis\README.md` Entry Options 表：`inject` = "Adds required services or intercept config for this entry"），
而 `- id: dsh-purge / inject: [...]` 是对**已存在行**的同名字段做覆盖。两者最终落到同一个字段上。

### 1.3 `!!js` 表达式与 `dshHomePath`

`PURGE` 里有一行 `root: !!js dshHomePath('redteam')`（`PURGE\cordis.patch.yml:66`）。机制：

- patch 文件用扩展过的 YAML schema 解析，`!!js` 标量变成 `{__jsExpr: "…"}`（`APPBOOT:20-31`）。
- Loader 在 entry 激活时把这种节点求值：`new Function('ctx','expr','with (ctx) { return eval(expr) }')`（`NM\cordis-plugin-loader\lib\index.js:233-241`）。
- `dshHomePath` 之所以能当裸函数名用：`APPBOOT:4077` 有 `ctx.provide('dshHomePath', dshHomePath)`，而求值作用域就是 `with(ctx)`。
  它就是 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath(seg)`（`NM\dsh-home-paths\README.zh.md`：`dshHomePath('settings')` → `$DSH_HOME/settings`）。

> 也就是说：**任何**在 root ctx 上 provide 的名字，都能在 patch 的 `!!js` 里当全局用。别滥用——它是在启动期 eval。

### 1.4 版本闸（踩了会很难查）

`APPBOOT:252-306` 的 `evaluatePluginCompatibility` 只看 **`peerDependencies`**，且只看名字是
`@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的项；不满足就是"插件与 runtime 不兼容"的告警 + 建议走 `dsh plugin allow-version` 豁免。
`@deepseek-ai/cordis` 不在这个前缀里 → 写它不会触发闸（`PURGE\package.json:88-90` 因此是安全的写法）。
`dsh.engines.dsh`（如 `@linxin666\dsh-client-ui-skills-explorer` 的 `dsh.engines.dsh`）在这个函数里**没有出现** →
它的消费点我没找到（**未验证**，可能只用于插件市场展示）。

**本骨架的选择**：完全不放任何 `@deepseek-ai/dsh*` peer，从根本上避开这道闸。

---

## 2. Q2 —— 服务端插件 vs 客户端 UI 插件

### 2.1 host（Node）半侧

就是普通 Cordis 插件。`PURGE\lib\index.js`：

- `:39` `export const name = "dsh-purge"`
- `:41-43` `export const inject = ["systemPrompt", "tools"]`（带一段很值的注释，见 §6.3）
- `:1454` `export function apply(ctx, config)`
- `:2590-2596` `const plugin = { name, inject, apply }; export default plugin`

两种导出风格都被官方/第三方用过：具名（`@linxin666/dsh-client-ui-skill-explorer\lib\index.js` 末尾 `export { ROUTES, apply, inject, name }`）
和 default 对象（上面）。**都行**（本骨架两种都给）。

### 2.2 client（浏览器）半侧

声明（`NM\dsh-package-manifest\lib\types\types.d.ts:76-79`，`DshClientManifest`）：

```jsonc
"dsh": {
  "client": {
    "platform": "web",        // 唯一被 Web 载体识别的值
    "inject": [ /* 包名依赖，见 2.3 */ ],
    "immediately": false,     // 可选：boot 第一阶段就注册 factory
    "external": []            // 可选：平台基座之外的模块请求
  }
}
```

bundle 协议（`NM\dsh-client-modules\lib\types\client\manifest.d.ts:177-183`）：

```js
window.__ModuleLoader__.load({
  id: '<包名>',                    // 必须等于 package name（同文件 :178 的注释："必须匹配正在执行的 graph row"）
  factory: (require) => { … return module.exports },
})
```

- `id` 必须是包名。`PURGE\client.js:1` = `"dsh-purge"`；skill-explorer = `"@linxin666/dsh-client-ui-skill-explorer"`。
  带 scope 没问题（官方 scoped 插件都这样）。
- factory 内**只能用 `require()` 拿平台基座里的模块**。基座表（冻结的 `PLATFORM_MODULES`）我从
  `NM\dsh-web-frontend\dist\assets\index-5SrrfWpU.js:126`（函数 `rM()`）里读出来了，正好 9 个键：
  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
- 执行 bundle 只**注册** factory，模块体副作用（含 CSS 注入）在首次物化时才跑（惰性 CJS；
  `NM\dsh-client-modules\README.zh.md`「浏览器加载什么 / 惰性 CJS 模型」两节）。
- 宿主侧把每个 `dsh.client` 声明变成 `/plugins` 下的一份 bundle，并由 `window.__DSH_BOOT__` 注入启动图
  （同上 README「启动 manifest 注入」；boot 类型见 `dsh-client-modules\lib\types\client\manifest.d.ts` 的 `WebBootGraph`）。

**关键推论**：`require('@deepseek-ai/dsh-client-ui-primitives')` 这类官方 UI 库**可以直接用**，
因为它们在基座表里，不需要写进 `dsh.client.external`，也不需要打包器把它们打进来。这条是本调研最省事的发现。

### 2.3 `dsh.client.inject` 不是 Cordis 服务注入

`NM\dsh-package-manifest\lib\types\types.d.ts:79` 原文："**Informational** package-name dependencies, not Cordis service injection"。
它会变成 boot 图里的包级依赖边（`WebBootEntry.inject`：「names package rows whose factories must arrive before this row materializes」），
用来保证"我的 bundle 到达时，某个包的 factory 已经注册了"。

Cordis 的**服务**注入是另一套：bundle 导出的 `inject` 数组（`PURGE\client.js:12` = `["slots","locale"]`），
Cordis 会等服务出现后再调 `apply(ctx)`。两套别混。

### 2.4 两侧怎么协作

同一个包里：

- `main` / `exports["."]` → Node 侧 Cordis 插件（`name` 用于日志，`inject` 是服务）
- `exports["./client"]` → 浏览器 bundle（`id` = 包名）
- patch 里通常只插**一行** host 侧 entry；client 侧不需要 patch 行，`dsh.client` 声明本身就会被 client-modules 扫成 boot row
  （`NM\dsh-client-modules\README.zh.md`：「把每个 `dsh.client` 声明变成 `/plugins` 下提供的 bundle」）。

`PURGE` 反过来用了多行（`dsh-purge`、`dsh-purge/redteam`、`dsh-purge/redteam/store`、`dsh-purge/redteam/ui`，`PURGE\cordis.patch.yml:37-70`），
说明"一个包拆多个子插件、用 `exports` 子路径各挂一行"也是官方支持的形态——适合把可选功能做成可单独禁用的一行。

---

## 3. Q3 —— 怎么注册一个设置页

### 3.1 先纠正一个前提

`dsh-purge` **用的不是** `settings.section`。它的 UI 入口是：

- `shell.overlay`（浮层）：`PURGE\client.js:8709-8714`
- `conversation.input.right`（输入框右侧按钮）：`PURGE\client.js:8684-8691`

所以"dsh-purge 的设置页"其实是它自己画的 dock 面板，不是设置面板里的一节。**要在设置面板里加一节，看官方包，不要看 dsh-purge。**

### 3.2 设置相关的槽位（`settings.*`）

类型定义在 `NM\dsh-client-ui-settings\lib\types\client\contract\slots.d.ts`：

| 槽位 | 行 | kind | 用途 |
|---|---|---|---|
| `settings.launcher` | 14-18 | single | 侧栏账户入口，打开设置面板 |
| `settings.trigger` | 27-31 | single | 侧栏底部触发行的内容（icon+label） |
| `settings.header` | 37-41 | single | 面板标题 |
| `settings.action` | 47-51 | list | 内容列头部动作（关闭按钮左侧） |
| `settings.close` | 57-61 | single | 关闭按钮的无障碍文案 |
| **`settings.section`** | **73-77** | **list** | **一个设置页 = 一条 list 条目**（`id` 分区键、`order` 位置、`label` 菜栏文字） |
| `settings.plugins.tab` | 86-90 | list | 「插件」分区内的一页 |
| `settings.onboarding` | 101-105 | list | 引导步骤 |
| `settings.general.item` | 120-124 | list | 「通用」页里的一行偏好项（不值得占整页时用这个） |

运行时由谁声明：`ui-settings-general` 注册 `sidebar.settings` 时把 `settings.section` 作为 child 槽位声明出来
——`NM\dsh-client-ui-settings-general\lib\client.js:1112`（`name:"sidebar.settings"`）、`:1136-1139`（`"settings.section": {kind:"list", scope:"root"}`）。
所以**只要有设置面板，这个槽位就存在**；desktop profile 的 patch 覆盖了 `ui-settings-general` 的 config（`profiles\desktop\cordis.patch.yml:4-8`），
证明它在跑。

### 3.3 注册一个设置页（最小代码）

官方 `models` 页（`NM\dsh-client-ui-settings-models\lib\client.js:4059-4070`）与 `general` 页（`settings-general:1171-1180`）都是这个形状：

```js
// 浏览器 bundle 内
function apply(ctx) {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'my-page',        // 分区键，也用于 only 过滤
        order: 500,           // 菜栏位置（general=0，models=10）
        label: '我的页面',     // SlotLabel = string | (() => string)（ui-slots types:555）
      },
      MyComponent,          // register(opts, component)（ui-slots types:533）
    ),
  )
}
```

- `ctx.slots.inject(name, cb)`：等这个槽位**被声明**之后再执行 cb（`NM\cordis\lib\types\registry.d.ts:185`：`inject(inject, callback)`）。
  `register` 返回注销函数，`ctx.effect` 会把它收走。
- 组件拿到的 props（`slots.d.ts:154-157` `SettingsSectionOwnerProps`）：`{ close: () => void }`（关掉设置面板）。
  想读 locale 文案要在 register 时声明 `locale: '<NS>'`，组件里才有 `t`（`PURGE\client.js:8686-8689` 的 `t: ctx.locale.bind(NS)` 是手动注入的等价写法）。
- 外壳怎么读这些条目：`settings-general\lib\client.js:1023-1028` 遍历 `ctx.slots.entries('settings.section')`，取 `id/order/label`，
  `label` 过 `resolveSlotLabel(...)` 再排序渲染。所以 `label` 给**字符串**就行，不必注册 locale。

### 3.4 UI ↔ host 怎么通信（HTTP 还是 RPC？）

两条路，官方都在用：

**A. 同源 `fetch` 打自己注册的具名路由（推荐，零依赖）**

- 客户端：`@linxin666/dsh-client-ui-skill-explorer\lib\client.js:23-30` 定义了 `API` 表，
  注释明确写"**DOCUMENT-RELATIVE on purpose (no leading slash)**：shell 用 `<base href="./">`，写绝对路径会在子路径部署时逃出前缀（issue #1707）"。
- 宿主：同一个包的 `lib\index.js:1206-1213` 用 `ctx.webServer.register` 挂路由族。
- `dsh-purge` 同样路线：`PURGE\lib\redteam\ui.js:1079-1082` 挂 `POST /redteam/api`，并在文件头 `:11-14` 写了
  「为什么走 webServer 而不是 typert/@Remote：本包与 store 包都刻意保持零外部依赖…具名路由是最小且稳定的接缝」。

**B. Cordis Remote RPC（`ctx.connection.call`）**

- 客户端侧 API：`NM\dsh-client-connection\lib\types\index.d.ts:218`
  `call(channel, endpoint, payload, signal): Promise<ConnectionRpcResult<unknown>>`。
- 宿主侧要注册对应 Remote；官方是用 typert 生成的 Remote（`dsh-api-remotes` / `dsh-typert-*`）。
  **第三方插件不写 typert 代码生成时怎么手工注册 Remote —— 未验证**（我没找到公开的注册入口文档，
  `dsh-api-remotes\lib\types\index.d.ts` 只有一个 `apply(ctx)` 与 `inject`，没有第三方向注册面）。

**认证边界（重要）**：`/api` 这条路（含 WebSocket mux）由 `dsh-client-connection` 独占，带启动 token → 签名 cookie 的浏览器认证
（`NM\dsh-client-connection\README.zh.md`「浏览器认证与请求信任」）。
而**你自己用 `ctx.webServer.register` 挂的具名路由不在这个栅栏里** —— 所以 Host/Origin 校验得自己写，
`dsh-purge` 就是这么干的（`PURGE\lib\redteam\ui.js:1083-1086` POST only、`:1087-1114` 回环放行 + 非回环要求 Origin==Host，否则 403）。
本骨架抄了这个策略（见 §5.3）。

---

## 4. Q4 —— 怎么注册一个后端 HTTP 端点

### 4.1 API 形状

`NM\dsh-host-webserver\lib\types\index.d.ts`：

```ts
// :33-38
type WebRouteKind = 'exact' | 'prefix'      // 'prefix' 匹配 p 和 p/<anything>
interface WebRoute {
  kind: WebRouteKind
  path: string                              // 绝对 pathname，无尾斜杠
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>  // 自己管完整个响应生命周期
}
// :100-106
register(route: WebRoute): () => void       // 重复的 (kind, path) 抛错；返回值是注销函数
```

同一服务还有 `registerUpgrade`（WebSocket/upgrade）、`registerFallback`（唯一兜底座位）、`tapIndex`（改 index.html）、
`collectIndexInjections`/`renderIndex`（结构化 index 注入）。`port` / `host` 是 getter。
它**只做路由**，不 serve 文件（文件由 `dsh-host-frontend-static` 之类的 fallback owner 负责）。

### 4.2 三条已验证的挂法

1. 直接挂一条 exact 路由 —— `PURGE\lib\redteam\ui.js:155`（`inject = ['redteam','webServer']`）、`:1079-1082`：
   ```js
   ctx.effect(() => ctx.webServer.register({
     kind: 'exact',
     path: '/redteam/api',
     handler: async (req, res) => { … },   // POST only + 来源校验 + JSON
   }))
   ```
   `ctx.effect` 包起来是为了插件被禁用/热重载时自动注销（同文件 :1055-1057 的注释说明了这点）。
2. 一次挂一族 —— `@linxin666\dsh-client-ui-skill-explorer\lib\index.js:1206-1213`：
   `routes.map(r => ctx.webServer.register(r))`，在 effect 的清理函数里逐个 dispose。
3. 本骨架：同 (1)，但只用 `['webServer']` 一个必需服务。

**不是** `dsh-api-gateway`：gateway 持有 `/api` 那条路由和 Remote 多路复用流（`dsh-client-connection\README.zh.md`「一元 RPC」段），
第三方插件往里加端点没有公开入口（**未验证**有没有隐藏面）。

### 4.3 自己负责的三件事

1. **来源校验**：见 §3.4 的认证边界。
2. **只允许受控方法/体积**：`register` 不管这些（本骨架：POST only、64 KiB 上限、坏 JSON → 400）。
3. **重复 path 会抛错**：`(kind, path)` 冲突是组合期契约错误，不是"后覆盖前"（types:100-106）。
   所以 patch 里的 `config.endpointPath` 要自己保证唯一（本骨架默认 `/dsh-plugin-skeleton/api`）。

---

## 5. Q5 —— cordis 服务注入机制

### 5.1 `inject` 的三种写法

| 写法 | 语义 | 依据 |
|---|---|---|
| 插件导出 `export const inject = ['a','b']` | 服务 `a`、`b` 都出现后才首次执行 `apply` | `cordis\README.md`："inject tells Cordis which services must exist before the plugin runs" |
| `ctx.inject(['a'], (host) => …)` | 运行期等某个服务出现后再跑回调（可以多次、可条件化） | `NM\cordis\lib\types\registry.d.ts:185` |
| `ctx.provide(name, value)` | 自己往 ctx 上挂一个服务 | `NM\cordis\lib\types\reflect.d.ts:43` |

`inject: [systemPrompt, tools]` 就是第一种：等"系统提示词注册表"和"工具注册表"都在，才让 `dsh-purge` 的 `apply` 跑，
这样它才能往提示词里插段、往工具面里插工具。**它不是"请求权限"，也不是"依赖注入容器里的私有字段"**——
Cordis 的做法是：服务出现 → 触发依赖它的 fiber 激活；服务消失 → 反激活。

### 5.2 一个插件能注入哪些服务（host 侧，按包索引）

`declare module '@deepseek-ai/cordis' { interface Context { … } }` 的实测清单（全部来自各包 `lib/types/index.d.ts` 的 `interface Context`）：

| 服务名 | 类型 | 提供者包 | 行 |
|---|---|---|---|
| `webServer` | `WebServer` | `dsh-host-webserver` | 17 |
| `tools` | `ToolRuntime` | `dsh-tools` | 34 |
| `systemPrompt` | `SystemPrompt` | `dsh-system-prompt` | 12 |
| `sessions` | `SessionStore` | `dsh-session` | 28 |
| `skills` | `SkillRegistry` | `dsh-skill` | 201 |
| `settings` | `SettingsForms` | `dsh-settings` | 27 |
| `subagents` | `SubagentRuntime` | `dsh-subagent` | 64 |
| `agents` | `AgentRegistry` | `dsh-agent` | 20 |
| `workspaceRegistry` | `WorkspaceRegistry` | `dsh-workspace` | 82 |
| `commands` | `CommandRuntime` | `dsh-commands` | 65 |
| `storage` | `Storage` | `dsh-storage` | 25 |
| `jobs` | `JobRegistry` | `dsh-jobs` | 18 |
| `goals` | `GoalService` | `dsh-goal` | 19 |
| `schedule` | `ScheduleService` | `dsh-schedule` | 15 |
| `llm` | `LlmRuntime` | `dsh-llm` | 30 |
| `credentials` | `CredentialProvider` | `dsh-credentials` | 100 |
| `sandbox` | `SandboxProvider` | `dsh-sandbox` | 118 |
| `userQuestions` | `UserQuestionService` | `dsh-user-questions` | 16 |
| `approval` | `ApprovalService` | `dsh-user-approval` | 21 |
| `tokenMeter` | `TokenMeter` | `dsh-token-meter` | 16 |
| `fs` | `FileSystem` | `dsh-fs` | 17 |
| `shell` | `ShellExecutor` | `dsh-shell` | 16 |
| `sessionQuery` | `SessionQueryEngine` | `dsh-session-query` | 25 |
| `workflowEngine` | `WorkflowEngine` | `dsh-workflow` | 15 |

client 侧（浏览器 Cordis 树）常用：`slots` / `uiRenderer`（`NM\dsh-client-ui-renderer\lib\types\client\index.d.ts:26-28`）、
`locale`、`connection`、`configForms`、`settingsSchema`、`remote.*`（后者见 `settings-models\lib\client.js:3994-4001` 的 inject 列表）。
`slots` 的实现在 ui-renderer（所以用了 slots 的客户端插件，`dsh.client.inject` 里常列 `@deepseek-ai/dsh-client-ui-renderer`，如 skill-explorer 的 package.json）。

第三方插件还可以**自己提供服务**：`dsh-purge` 的 store 子插件用 `ctx.provide('redteam', store)` 挂出 `ctx.redteam`
（`PURGE\lib\redteam\store.js:20` 的 `name = 'redteam-store'`、`:77` 的 provide），ui 子插件再 `inject: ['redteam','webServer']` 消费它
（`PURGE\cordis.patch.yml:58-70` 三行 + `PURGE\lib\redteam\ui.js:155`）。这是"一个包拆成多个可独立禁用的子插件"的正统玩法。

### 5.3 最大的坑：注入不存在的服务 = 静默卡死

`PURGE\lib\index.js:41-43` 那段注释值得抄进脑子：

> 不要把 pluginPackages 写进 inject：Cordis 会对 map 里每一个 key 空等。
> 便携拷贝 / Hub 残装经常没有这项服务，一写进去就是 pending → 宿主退出码 1。

所以：**`inject` 只写你确实要用的服务，而且能在目标 profile 里必然存在的那些**。
装到不认识的 profile 里时，宁可 `ctx.get('x')` 探测后再降级（skill-explorer 的 `ctx.get('loader', false)` 就是这种防御写法），
也不要把名字硬塞进 `inject`。

---

## 6. Q6 —— 本骨架说明

### 6.1 文件清单（含行数）

| 文件 | 行数 | 作用 |
|---|---|---|
| `package.json` | 36 | 身份 + `dsh.bundle.patch` + `dsh.client.platform` + `exports` |
| `cordis.patch.yml` | 18 | 往 profile 根插一行 entry（带注释解释 patch 语义） |
| `src/index.ts` | 113 | host 半侧：`POST /dsh-plugin-skeleton/api` + 一条启动日志 |
| `client.js` | 84 | 浏览器半侧：手写 CJS factory，注册一个 `settings.section` 设置页，按钮 POST 上面那个端点 |
| `tsconfig.json` | 8 | 只编 `src/` → `dist/`（沿用仓库根的 `tsconfig.base.json`） |
| `dist/*` | 生成 | `tsc` 产物（已构建好，可直接加载） |

代码行合计 **197 行**（113 + 84），零前端构建、零运行期第三方依赖。

设计上的三个取舍：

1. **`main` 指向 `dist/index.js`**（跟本仓库 `packages/*` 的约定一致），所以要先 `tsc`；我本地已构建，`dist` 在。
   注意仓库根 `.gitignore` 有一行 `dist/`，所以 `dist` 不会进版本库——换机器/新 clone 后要先 `pnpm -r build`（或 `tsc -p`）再装。
2. **`client.js` 不走 tsc、不走打包器**：ModuleLoader 只吃「`window.__ModuleLoader__.load({id, factory})` 单文件 CJS factory」，
   tsc 会把它编成 ESM `import`（协议不接受）。用 bundler（tsdown/vite）也行，但要多一个构建脚本 + 一个依赖。
   手写反而更短：84 行，且只 `require('react')`（基座表里的键）。
3. **不写 `@deepseek-ai/dsh*` peer**：避开 `APPBOOT:252-306` 的版本闸（见 §1.4）。

### 6.2 怎么装（三种，任选；都不需要 `npm/pnpm install`）

**A. junction + profile 自己的 patch（最小改动，推荐）**

```powershell
# 1) 把包挂进 profile 的 node_modules（和 dsh-purge 一样的手法：现网就是 junction）
cmd /c mklink /J "C:\Users\<你>\.dsh\profiles\desktop\node_modules\@dsh-feishu\dsh-plugin" "D:\dsh-feishu\packages\dsh-plugin"

# 2) 在 profile 的 patch 层加一行 insert（不改 cordis.yml，那文件是空的 entry 列表）
#    编辑 C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml，追加：
#      - insert:
#          - id: dsh-plugin-skeleton
#            name: '@dsh-feishu/dsh-plugin'
#            config:
#              endpointPath: /dsh-plugin-skeleton/api
```

**B. 登记成 profile bundle（更像一个"正式插件"）**

`profiles\desktop\package.json` 里两处都要加：

```jsonc
"dependencies": { …, "@dsh-feishu/dsh-plugin": "link:D:/dsh-feishu/packages/dsh-plugin" },
"dsh": { "profile": { "bundles": [ …, "@dsh-feishu/dsh-plugin" ] } }
```

bundle 列表里加了之后，launcher 才会读它的 `dsh.bundle.patch`（依据 `APPBOOT:463-489` 的 profile 组合说明：
bundles 各自的 patch → profile 自己的 `cordis.patch.yml` → 启动器的 `--patch` 层）。
注意改 npm 依赖字段一般意味着要 `pnpm install`，所以纯手工场景用 A 更省事。

**C. 完全不装，只做离线验证**（我实际只做到了这一步，见 6.3）

**验证入口**：重启 DSH 后

- host 侧：控制台 / `%DSH_HOME%\dsh-web.log` 里应出现 `[dsh-plugin-skeleton] enabled; HTTP route = /dsh-plugin-skeleton/api`
  （`ctx.logger` 是真 printf，`%s` 会被替换——`NM\cordis\lib\index.js:435-451` 的 `Logger.format`）。
- 端点：`POST http://127.0.0.1:18516/dsh-plugin-skeleton/api`，body `{"op":"ping"}` → `{"ok":true,…}`。
- UI 侧：设置面板菜栏应多一项「插件骨架」，点进去有一个按钮，点它会 POST 上面的端点并把响应打在 `<pre>` 里。

### 6.3 验证矩阵（做了什么 / 没做什么）

| 项 | 状态 | 证据 |
|---|---|---|
| `tsc` 编译 | ✅ 通过 | `node_modules\.bin\tsc -p tsconfig.json`，exit 0 |
| 产物语法 | ✅ 通过 | `node --check dist/index.js`、`node --check client.js` |
| 导出形状（name/inject/apply） | ✅ 通过 | 离线冒烟 14 项 |
| 路由注册 / dispose 注销 | ✅ 通过 | 同上（real `node:http` + 假 ctx） |
| `POST` 200 + 回显、`GET` 405、坏 JSON 400、体积上限 400、同源 Origin 放行 | ✅ 通过 | 同上 |
| patch YAML 结构 / 清单字段 / 包名合法 / 无 dsh peer | ✅ 通过 | 清单自检 14 项（用 DSH 自带的 `js-yaml` 解析） |
| `trustedOrigin` 的**非回环**分支（410/403 那条） | ⚠️ 未覆盖 | 本机只能产生回环请求；该分支只是照抄 dsh-purge 的判据 |
| 真机启动 DSH 后是否报错 | ❌ **未验证** | 硬性要求不许改 `~\.dsh`，所以没装进 profile |
| 设置面板里是否真的出现那一节、React 渲染是否正常 | ❌ **未验证** | 需要装进 profile 并刷新页面 |
| `settings.section` 在 Electron 桌面壳里是否同样可用 | ⚠️ 高度可疑但未验证 | 同类槽位由 `ui-settings-general` 声明（`client.js:1136`），而该包在本 profile 的 patch 里被配置（`profiles\desktop\cordis.patch.yml:4-8`）→ 说明在跑；但"能看到入口"没实测 |

复现命令（两个脚本在 `D:\dsh-feishu\.tmp\`，可随时删）：

```powershell
cd D:\dsh-feishu
node .tmp\dsh-plugin-smoke.mjs            # 14/14，真实 HTTP 打到 dist/index.js
node .tmp\dsh-plugin-manifest-check.mjs   # 14/14，清单 + patch 结构
```

### 6.4 未验证清单（明确列出来，别当结论用）

1. **真机加载**：本骨架没有实际装进 desktop profile。`cordis.patch.yml` + junction 的路径写法是照抄现网 `dsh-purge` 的
   （`profiles\desktop\node_modules\dsh-purge` 是 junction → `~\.dsh\plugins\dsh-purge`），但没有跑通一次。
2. **设置页是否渲染**：`settings.section` 的注册代码形状有两处官方实样（models / general），但我的组件没在浏览器里跑过。
   最可能的失败点：`register` 的 options 少了某个必填项（类型上 `id`/`order`/`label` 都是可选），或 list 条目的组件签名要求更多 props——**未验证**。
3. **`dsh.client.inject` 留空**：manifest 注释说它只是信息性包依赖，我的 bundle 只 `require('react')`（基座种子），
   所以理论上不需要排序保证；但"留空 + 只 require 种子模块"这种组合没有官方实样，**未验证**。
4. **`dsh.engines.dsh` 的消费点**：在 `APPBOOT` 里没找到读取处（版本闸只看 `peerDependencies`），**未验证**它到底被谁用。
5. **`dshTarget` 字段**：在 `APPBOOT` / `dsh-host-plugin-inventory` 里 grep 不到读取点，判为包自定义字段（**未验证**是否还有别处读）。
6. **手工注册 Cordis Remote**（不用 typert 代码生成）：**未找到入口**，所以本骨架走 HTTP 路由。
7. **`/plugins` 路由下 scoped 包名的 URL**（`@dsh-feishu/dsh-plugin`）：官方 scoped 插件（`@linxin666/...`）能工作，
   说明 client-modules 处理了 scope，但我没直接观察它生成的那个 URL。

---

## 7. 如果要把这个骨架做成「完整的设置页」，还要多少

用可核对的指标说：

| 维度 | 现状（本骨架） | 一个像样的设置页 | 差距 |
|---|---|---|---|
| 文件数 | 5（含 tsconfig）+ dist | 6-8（不变，还是那 5 个 + 可能的 `src/client/` 拆分） | +0…3 个文件 |
| 是否需要前端构建 | **不需要**（手写 CJS factory，只用基座表里的 `react`/`ui-primitives`） | 仍**不需要**——除非引入第三方 npm 前端库或 JSX 语法糖；那时要 +1 个打包脚本（esbuild/tsdown）+ 把产物包成 `window.__ModuleLoader__.load` 外壳 | 0 或 +1 脚本 |
| 行数 | 197（host 113 + UI 84） | 300-800：每个后端操作 1 条 `fetch` + 1 个 handler；每张表单/列表 1 个组件 | ×2…×4 |
| 后端路由 | 1 条 exact 路由 | 通常 `GET` 列表 + 若干 `POST`（每条一次 `register`，或一个 prefix 路由内自己分发 op——dsh-purge 就是后者：`ui.js:1081` 一条 `/redteam/api` 接所有 op） | +1…8 条 |
| 状态管理 | `useState` 一把梭 | 官方风格是 `@deepseek-ai/dsh-client-store`（基座表里，可 require）+ `slots` 的 store 席位（`defineStore`） | 可选，+50…150 行 |
| 前端依赖 | 0 | 0（`react` / `ui-primitives` / `ui-slots` / `client-store` / `dockkit` 都在基座表） | 0 |
| 参考量级 | — | `@linxin666/dsh-client-ui-skill-explorer`：host 46 KB + client 62 KB（tsdown 打包，含 6 条路由）；`dsh-purge`：client 单文件 **498 KB**（手工维护，含多个面板） | — |

**判断**：UI 机制本身不复杂（一个 `window.__ModuleLoader__.load` 外壳 + `ctx.slots.inject/register`），
**不需要** React 之外的框架，**不需要** webpack/vite，**不需要** npm 打包进 profile。
真正的成本在两处：

1. 列表/表单这类"业务 UI"要自己写（官方 primitives 能省一部分，但要读它的 props 约定——`dsh-client-ui-primitives` 我没细读，**未验证**其 API 面）。
2. 宿主侧每个 op 都要自己做来源校验、体积限制、错误映射（`webServer` 不提供任何中间件）。

如果只想"能用"：保持本骨架形态（1 条 prefix 路由 + 一个组件 + `useState`），300 行以内能做出一个可浏览/可提交的设置页；
如果要"像官方那样"（store 席位、locale 字典、`configForms` 自动表单、乐观更新），那就是 600-800 行并且要读 4-5 个官方包的源码。

---

## 附：一句话备忘

- 要 **一个能跑的东西**：`package.json`(main+exports) → patch 一行 → `export const inject/name/apply`。
- 要 **一个端点**：`ctx.effect(() => ctx.webServer.register({kind:'exact', path, handler}))`，来源校验自己写。
- 要 **一个 UI**：`dsh.client.platform="web"` + `exports["./client"]` + 手写 `window.__ModuleLoader__.load({id:包名, factory})`。
- 要 **一个设置页**：bundle 里 `ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id, order, label}, 组件))`。
- 别把不确定的服务名塞进 `inject`。
