# add-feat

OpenCode V2 插件：在普通会话内提供 subagent 多模型开发工作流——澄清 → 计划 → 人工确认 → 开发（TDD）→ 独立审计 → 修复 → 最终验收，全程留下可信证据。

关键设计：**编排在 agent 层，强制规则在插件层**。阶段推进、测试执行、改动一致性核验由插件在服务端完成，模型口头说"通过了"不算数。

```
你 ──需求──> 协调者 Sol（澄清 → 计划 → 等你确认 → 调度 → 验收）
                ├─ 开发者：TDD 实现，只改计划允许的文件
                ├─ 审计者：独立审计，可用 /tmp 脚本与一次性容器复现，不改仓库
                └─ 修复者（高/低复杂度）：按审计编号最小修复
```

功能全览见 [docs/使用说明.md](docs/使用说明.md)（含执行流程图、工作间隔离、交付规范衔接）。

## 安装

前置要求：

- OpenCode V2（基于 2.2.1 验证），终端可用 `opencode` 命令；
- 在 **git 仓库**内使用（改动核验依赖 git）；
- Node ≥ 20（安装脚本与模型切换 CLI 需要）；运行插件测试需要 [bun](https://bun.sh)；
- 可选增强：若本机有 `grilling` skill，协调者的澄清阶段会自动加载它（设计树 + frontier）；没有也能用，会走内置的精简质询协议；
- 协调者/审计者默认模型为 `openai/gpt-6.1-sol`、`openai/gpt-6.1-terra`，开发/修复为 `zhipuai-coding-plan/glm-5.3(-flash)`。**没有对应套餐没关系，装完用 `add-feat-model` 一条命令换成你有的模型**（见下文）。

### 1. 安装插件本体

```bash
opencode plugin add github:wyn-ying/add-feat
```

或固定版本：

```bash
opencode plugin add github:wyn-ying/add-feat#v0.1.0
```

私有仓库用 SSH：

```bash
opencode plugin add git+ssh://git@github.com/wyn-ying/add-feat.git#main
```

### 2. 落盘 agents / 命令 / 默认配置

`plugin add` 只安装插件本体；协调者、四个角色 agent、`/add-feat` 命令和默认配置需要跑一次安装脚本：

```bash
npx github:wyn-ying/add-feat        # 等价于下面两步；或克隆后：
node install.mjs
```

脚本行为：

- 把 `agents/*.md` 复制到 `~/.config/opencode/agents/`，`commands/add-feat.md` 到 `~/.config/opencode/commands/`；
- 三份撰写规范复制到 `~/.config/opencode/add-feat-docs/`，agent 固定引用该路径，与插件包安装位置解耦；
- **已存在的文件跳过**（`--force` 覆盖 agents/commands，但永远不覆盖你的 `~/.config/opencode/add-feat.json` 用户配置）。

### 3. 配置模型（必看）

各角色的默认模型写在 agent 文件 frontmatter 的 `model:` 行。切换角色模型不需要手工编辑：

```bash
# 安装脚本会把 CLI 放到固定位置，后续直接用
node ~/.config/opencode/add-feat-model.mjs show                 # 查看全部角色当前模型
node ~/.config/opencode/add-feat-model.mjs set developer        # 交互选择器（从 opencode models 清单过滤）
node ~/.config/opencode/add-feat-model.mjs set developer zhipuai-coding-plan/glm-5.3-flash
node ~/.config/opencode/add-feat-model.mjs unset developer      # 还原出厂模型
```

在克隆的仓库目录内也可以直接 `node add-feat-model.mjs ...`。

- 模型 ID 必须存在于 `opencode models` 清单，拼错会被拒绝并给出相似候选；`--force` 可跳过校验；
- 只改 agent 文件 frontmatter 内的 `model:` 行，其余内容零改动；出厂值自动记录，`unset` 一键还原；
- 修改后下一个子代理生效；**子代理运行中切换会造成同阶段混用两个模型**，尽量等阶段结束。

### 4. 重启并验证

```bash
opencode service restart
```

新开一个 OpenCode 会话，执行 `/add-feat 你好`——协调者开始逐项澄清即安装成功。

## 使用

在你的项目目录：

```text
/add-feat 实现用户邮箱格式校验
```

你需要在几个时刻参与：确认计划与是否使用独立工作间；审计通过后选择是否需要面向调用方的交付界面；修复预算耗尽或合并回主目录时做决定。其余（TDD 红绿、服务端独立测试、独立审计、最终验收复检）由工作流自动推进。详细说明见 [docs/使用说明.md](docs/使用说明.md)。

## 配置

`~/.config/opencode/add-feat.json`：

```json
{
  "maxRepairs": 4,
  "testTimeoutSeconds": 480
}
```

- `maxRepairs`：审计不通过时的最大修复轮数（1–8）；
- `testTimeoutSeconds`：服务端执行验收命令的单条超时。

## 任务状态与数据

- 状态与日志：`~/.local/state/add-feat/`（按项目目录分文件，0600）；
- 模型覆盖记录：`~/.local/state/add-feat/model-overrides.json`；
- 过程文档（plan/dev/audit/delivery）写在项目 `docs/` 下，路径规则来自项目 AGENTS.md（可自定义），入库策略由项目规则决定。

## 开发与测试

```bash
git clone https://github.com/wyn-ying/add-feat
cd add-feat && bun install && bun test
```

93 项测试（状态机、文档落地、git 摘要、工作间隔离、模型 CLI），零模型调用。

## License

MIT
