# 插件与官方浏览器

Core 提供轻量插件宿主，`browser` 是第一个官方内置插件，使用
[agent-browser](https://github.com/vercel-labs/agent-browser) 的原生 stdio MCP。
插件代码和权限执行属于 Core；CLI/Web 只负责管理和展示，不各自启动浏览器。

## 启用之前

- 插件默认禁用。列表和配置展示不启动程序、不访问网站。
- `configured` 只表示已经配置，不表示可执行文件或 Chrome 已验证可用。
- 显式健康检查会启动独立 MCP 进程、握手和核对工具协议，然后清理；
  `ready` 不代表 Chrome 已成功启动，也不代表网站访问成功。
- agent-browser 是精确锁定的可选依赖；禁用浏览器不影响 Core 启动。
  宿主需要可用的 Chrome，可通过 `browserExecutablePath` 指定绝对路径。
  不在工具调用中自动安装、升级或重装浏览器。
- 可执行文件是宿主信任的程序。进程分离和域名过滤不是操作系统沙箱。
  不从工作区自动导入插件代码，不读取真实用户的浏览器 profile、cookie 或凭据。

浏览器配置示例：

```json
{
  "executablePath": "agent-browser",
  "browserExecutablePath": "/usr/bin/google-chrome",
  "allowedDomains": ["example.com", "*.example.org"]
}
```

`executablePath` 是 agent-browser 程序，不是 Chrome；默认值使用内置可选依赖。
自定义路径需要用户显式信任。`browserExecutablePath` 为空时由后端探测浏览器，
不是导入用户的浏览器状态。

本版固定适配 `agent-browser@0.39.2`，默认解析只接受本包提供的这一版本，
不会改用 PATH 中的未知版本。该 npm 包声明 Node >=24，pnpm 在本仓 Node 22
环境会跳过其 optional 安装；开发依赖用 `agent-browser-dev` 别名提供同一版本
供本地运行和验证（不代表上游声明支持 Node 22，严格 engine 检查仍可能拒绝安装）。
仅安装生产依赖时不能假设该程序存在，应显式准备相应版本的 native 可执行文件并
配置 `executablePath`；缺失时健康检查返回 `unavailable`，不会自动安装或换版本。

`allowedDomains` 是主机名列表，不是 URL 或 exact origin。可显式设置
`"allowedDomains": ["*"]` 允许任意 HTTP(S) 主机，包括本机和局域网，不必预先列出
AI 将访问的网站。`*` 会关闭底层域名过滤（也覆盖重定向和子资源）；即使与其它条目
混合，仍表示全部允许。这只放开域名，不绕过 Forge 权限、审批或导航 URL 校验，
也不导入个人浏览器状态。空列表仍不授权，不能启用插件；不会自动转换成 `*`。

若需要限制访问范围，填写具体主机名或 `*.example.org`（同时匹配根域和子域），
并包含子资源使用的域名。开发本地应用时加入 `localhost` 或 `127.0.0.1`。
允许某主机名会允许它的 HTTP(S) 端口，不能把它当作端口隔离。
Web 设置中填写 `*` 后先点“保存配置”，再点“启用插件”。

浏览器功能只有此插件一个入口。旧版 Playwright 工具后端、全局浏览器设置及 CLI
`--browser-origins` / `--browser-executable` 参数已移除；插件禁用时不注册任何
`browser_*` 工具，失败时也没有旧后端可回退。已保存的旧 `browserAllowedOrigins`
和全局 `browserExecutablePath` 仅在读取历史配置时被丢弃，后续保存会移除；不会影响
其它设置，也不会迁移成插件授权或覆盖已经配置的插件。插件内的同名
`browserExecutablePath` 仍用于选择 Chrome/Chromium。

Playwright 仅作为开发测试依赖保留，不再是 Core 的生产/可选运行依赖。

## 客户端与嵌入调用

CLI 的 `forge plugins` 管理配置，Web 的插件界面提供相同功能。共享状态由
`FORGE_HOME/plugins.json` 的带版本私有文件持有，写入经过文件锁和原子替换。
能力声明仅供展示，不授予权限。

嵌入者也可以通过 HarnessService 调用：

```ts
await service.configurePlugin!({
  pluginId: "browser",
  config: {
    executablePath: "agent-browser",
    browserExecutablePath: "/usr/bin/google-chrome",
    allowedDomains: ["example.com"],
  },
});
await service.checkPlugin!("browser"); // 显式启动协议诊断，不打开页面
await service.configurePlugin!({ pluginId: "browser", enabled: true });
```

`listPlugins`、`configurePlugin`、`checkPlugin`、`browser` 复用现有 RPC/bridge，
没有独立的未鉴权浏览器控制端口。网络入口仍遵守 Core 自身的部署安全边界：
可信局域网直连模式并不要求用户登录，不要向公网无保护地暴露 Core。

普通 CLI 与独立 Core 服务可能属于不同进程。共享 `FORGE_HOME` 不等于共享
活动浏览器；预览与接管必须连接正在执行该会话的同一个 Core。

## 工具、审批与资源生命周期

可用工具：

- `browser_navigate`：导航到授权的 HTTP(S) 主机；URL 不接受用户名或密码。
- `browser_snapshot` / `browser_read`：读取可访问性快照或当前渲染内容。
- `browser_click` / `browser_fill` / `browser_press` / `browser_scroll`：受控交互。
- `browser_screenshot`：生成有界截图并发布为会话附件，只将元数据放入模型上下文。
- `browser_close`：关闭本轮浏览器，不关闭其他会话。

先导航、获取快照，再按 `@ref` 操作；页面改变后重新获取快照。页面文字和图片
始终是不可信数据，不能改变系统指令、工具权限或代表用户同意。
不向模型暴露任意 `eval`、命令数组、`extraArgs`、外部 session、文件上传或 profile。

`readonly` 和 plan 模式禁止浏览器工具。`workspace` 每次工具调用都审批，
并在审批、接管等待之后重新检查当前权限与插件配置；`unrestricted` 省略审批，
但仍保留域名、参数和会话边界。

每个运行作用域按需创建独占后端，绑定 Forge 会话和工作区，子代理使用不同作用域。
首次获准使用工具之前不会启动浏览器。运行结束、取消、Core 正常退出、配置变更
或禁用时清理本 Core 拥有的资源。跨进程配置变更在另一进程的下一次操作前检查；
不宣称能够立即停止任意其他进程已经开始的动作。

本版不跨轮持久化登录态，不导入个人浏览器，不自动恢复或重放不确定的点击/提交。
`browser_close` 后须开启新一轮才能重建浏览器。异常清理失败会报错，不静默报告成功。

浏览器进程使用最小环境、独立 HOME 和私有配置；临时 profile 不复用个人登录态。
Unix socket 的长度限制可能要求 TMPDIR 和通信目录放在更短的私有临时路径，
这些目录权限为 0700，名称包含 Forge 文件、搜索及附件工具拒绝访问的 `credentials`
段，确认进程关闭后才清理。不能用持久 `--profile` 代替：上游拒绝将它与
`--allowed-domains` 一起使用。这仍不是针对任意宿主命令的 OS 沙箱。

## 同会话预览与人工接管

Web 面板首先只查询元数据；只有当前运行实际打开浏览器后才能预览。
预览是用户主动请求的截图，不是实时视频，也不是另一个 iframe 页面。
图像通过 Core 的现有传输返回，只保存在当前组件状态，不进入聊天历史。

1. 点击刷新截图可查看当前浏览器，不会获得输入控制权。
2. 显式接管后才能导航、获取快照、点击、填写、按键和滚动。人工动作由点击直接授权，
   仍检查当前运行权限和允许域名；接管不会给 Agent 增加权限。
3. 接管期间 Agent 的浏览器操作等待，但不冻结它的所有其他工具。
4. 归还后若页面在人工操作期间发生变化，之前等待的变更动作不会执行，
   Agent 必须重新获取快照再发出新动作。
5. 运行取消会终止等待；权限降为 readonly 后仍允许归还控制，但不允许新的浏览器动作。

页面断开不会代表取消运行，也不会猜测应当归还控制。重新连接同一 Core 后
显式归还，或取消该运行。模型调用 `browser_screenshot` 生成的附件与面板临时预览
是两个不同通路；前者可通过会话回放和附件接口访问。

## 扩展边界

- `src/shared/plugins.ts`：版本化 manifest、配置、健康状态与浏览器客户端契约。
- `src/store/plugins.ts`：私有配置、锁与修订号。
- `src/plugins/types.ts` / `host.ts`：宿主显式注册、配置校验、作用域装配与回收。
- `src/plugins/browser.ts`：浏览器权限、工具白名单、会话互斥和人工接管。
- `src/plugins/builtin/browser/`：agent-browser MCP 适配和外部进程资源。

首版插件贡献工具 registry 和有界的官方使用指令，继续复用已有 MCP、Skills 与
Tool Hooks；没有新增第三方动态加载器、市场、自动更新、任意 UI 代码注入或
工作区自动执行规则。新增官方插件实现 `PluginDefinition` 并由宿主显式注册；
manifest 的 `apiVersion` 不兼容时拒绝加载。

聚焦检查位于 `tests/plugins/`。端到端检查使用临时 Forge 状态、独立浏览器状态
和本地 fixture 页面，不读取真实 Provider 配置。已准备上述依赖和 Chrome 时可显式运行：

```sh
FORGE_BROWSER_SMOKE=1 pnpm exec vitest run tests/plugins/browser-native.test.ts tests/plugins/browser-live.test.ts
```

可用 `FORGE_BROWSER_EXECUTABLE` 指定 Chrome/Chromium 路径；不设置时测试使用已安装
Playwright 的 Chromium 路径，不自动下载浏览器。测试默认跳过真实浏览器检查，
不能把默认测试通过当成真实浏览器验收。
