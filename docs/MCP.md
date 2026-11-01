# MCP 接入与工具调用

MCP 支持 **stdio、Streamable HTTP、Legacy SSE**。注册不会连接；启用后才允许发现和调用，连接测试会握手并发送 ping。模型通过 `mcp_list_servers` → `mcp_list_tools` → `mcp_call_tool` 发现并使用工具；大工具目录按 `nextOffset` 分页，将返回值作为下一次 `mcp_list_tools` 的 `offset`。

私密环境变量和请求头由注册接口显式传入，保存在 `FORGE_HOME/mcp/servers.json` 的私有权限文件中；公共列表不返回凭据，也不允许用 `envNames` 任意读取宿主环境。API key 应放入私密请求头或环境变量，不放在 URL、命令参数或仓库文件里。

只读模式可查询服务器目录，但不能连接或调用；workspace 模式每次工具发现与调用均需审批。服务器 annotations 不授予权限。调用支持文本、结构化结果、图片、音频与资源块；结果递归脱敏且有大小限制，不自动重发工具调用。

无需外部服务的示例：[examples/mcp/echo-server.mjs](../examples/mcp/echo-server.mjs)。
