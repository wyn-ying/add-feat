#!/usr/bin/env node
/** add-feat 安装脚本：把 agents/commands/规范文档/默认配置落到 OpenCode 全局配置目录。
 *
 * 用法（仓库根）：
 *   node install.mjs            # 落盘缺失的 agents/commands；规范文档与默认配置按需写
 *   node install.mjs --force    # 用本仓库版本覆盖已有 agent/command 文件（永不覆盖用户 add-feat.json）
 *
 * 说明：
 *  - 插件本体由 `opencode plugin add` 安装并管理，本脚本只处理 OpenCode 不会自动安装的部分。
 *  - 三份撰写规范复制到 `~/.config/opencode/add-feat-docs/`，agent 内引用该固定路径，
 *    与插件包的实际安装位置解耦（插件升级换目录也不需要改 agent）。
 *  - `add-feat.json` 是用户配置（maxRepairs/testTimeoutSeconds），已存在则永不覆盖。
 */
import { readFile, writeFile, mkdir, stat, copyFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(homedir(), ".config/opencode")
const DOCS_TARGET = join(CONFIG, "add-feat-docs")
const FORCE = process.argv.includes("--force")

const AGENTS = [
  "add-feat.md",
  "add-feat-developer.md",
  "add-feat-auditor.md",
  "add-feat-fixer.md",
  "add-feat-fixer-flash.md",
]
const COMMANDS = ["add-feat.md"]
const DOCS = ["delivery撰写规范.md", "过程文档撰写规范.md", "使用说明.md"]

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

let written = 0
let skipped = 0

async function installFile(src, dst, { overwrite = false, transform } = {}) {
  if ((await exists(dst)) && !overwrite) {
    console.log(`  跳过（已存在）：${dst}`)
    skipped++
    return
  }
  await mkdir(dirname(dst), { recursive: true })
  const content = transform ? transform(await readFile(src, "utf8")) : null
  if (content !== null) await writeFile(dst, content)
  else await copyFile(src, dst)
  console.log(`  写入：${dst}`)
  written++
}

console.log("== 安装 agents ==")
for (const f of AGENTS) {
  await installFile(join(REPO, "agents", f), join(CONFIG, "agents", f), {
    overwrite: FORCE,
    // 规范文档路径固定为 ~/.config/opencode/add-feat-docs，模板中的占位写法直接保留即可；
    // 这里仅把可能残留的旧插件路径迁移到新位置。
    transform: (s) => s.replaceAll("~/.config/opencode/plugins/add-feat/docs", "~/.config/opencode/add-feat-docs"),
  })
}

console.log("== 安装 commands ==")
for (const f of COMMANDS) await installFile(join(REPO, "commands", f), join(CONFIG, "commands", f), { overwrite: FORCE })

console.log("== 安装撰写规范 ==")
for (const f of DOCS) await installFile(join(REPO, "docs", f), join(DOCS_TARGET, f), { overwrite: true })

console.log("== 安装模型切换 CLI ==")
await installFile(join(REPO, "add-feat-model.mjs"), join(CONFIG, "add-feat-model.mjs"), { overwrite: true })

console.log("== 安装 add-feat.json ==")
await installFile(join(REPO, "defaults/add-feat.json"), join(CONFIG, "add-feat.json"), { overwrite: false })

console.log(`\n完成：写入 ${written}，跳过 ${skipped}。`)
console.log("若 OpenCode 正在运行，请执行：opencode service restart")
console.log(`验证：新会话执行 /add-feat 你好；模型切换：node ${join(CONFIG, "add-feat-model.mjs")} show`)
