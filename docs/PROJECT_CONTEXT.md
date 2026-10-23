# 项目指令与技能

Forge 在运行边界读取工作区上下文；项目约定放在 `AGENTS.md`，按需使用的专门流程放在 `SKILL.md`。它们是指令数据，不会自动执行命令，也不能授予工具权限。

## AGENTS.md 的作用域

- 工作区根 `AGENTS.md` 始终适用。Forge 不向工作区父目录或 home 搜索指令。
- 子目录约定通过 `project_context({ path: "相对目录" })` 按需读取；返回从根到目标子树的指令链，不混入兄弟目录。
- 文件必须在允许范围内，超限、二进制/NUL、敏感内容或不安全符号链接会被拒绝并显示原因。单份指令正文上限为 64 KiB。

在 Forge 主仓作为工作区时，进入子模块需要读取相应子目录约定；单独以子仓作为工作区时，不会自动继承主仓文件。其他编码代理的指令发现规则由各自宿主决定。

## 添加一项技能

工作区技能按下列顺序发现：

1. `.forge/skills/<目录>/SKILL.md`
2. `.agents/skills/<目录>/SKILL.md`
3. 宿主通过 `createProjectContext(..., { extraSkillDirectories })` 显式提供的绝对目录

同一技能 ID 首个来源生效，重复项列为警告。不会扫描归档、任意父目录或其他应用的全局技能目录；额外目录是 Core API 选项，不是默认全局配置。

最小示例：

```markdown
---
name: review-storage-change
description: 修改会话存储时使用，检查旧记录兼容、恢复路径和聚焦回归。
---

先读取存储实现及相邻测试。检查旧记录读取、写入中断和恢复时不重放副作用，
再运行受影响的存储测试，报告实际结果及未覆盖项。
```

Forge 的 frontmatter 是有限的单行解析，只读取 `name`、`description`、可选 `version`，不要使用多行 YAML 描述。`name` 作为 ID；省略时使用目录名，`description` 必填。技能文件上限 64 KiB，目录最多收录 256 项。

模型先看到目录元数据，通过 `load_skill({ skill: "review-storage-change" })` 读取正文和来源目录。正文按需加载不意味着安装脚本或运行工具；目录里的脚本仍须通过正常权限流程执行。

## 查看与维护

已有会话可使用：

```sh
forge context SESSION_ID --json
forge skills SESSION_ID --json
```

交互会话可用 `/context`、`/skills` 查看。找不到技能时检查发现目录、frontmatter、重复 ID 和目录警告，不要复制到多个根目录来碰运气。

- README 写使用入口；AGENTS.md 写长期约定；技能写触发条件和可重复步骤。
- 删除过时步骤和重复约定；长参考材料单独存放，由正文明确指向。
- 不在技能中写密钥、机器临时状态、某一轮任务分工或一次测试通过的记录。
- 本项目目前没有随仓库提供的活跃技能包；旧单体示例保存在归档，不自动恢复为现役技能。

实现与限制见 [project-context.ts](../src/context/project-context.ts)，回归在 [tests/context](../tests/context)。
