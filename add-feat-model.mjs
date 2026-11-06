#!/usr/bin/env node
/** add-feat 角色模型切换 CLI。
 *
 * 用途：套餐用完或需要备用模型时，一条命令切换指定 add-feat 角色的模型，
 * 不需要手工找文件改 `model:` 行。
 *
 *   add-feat-model show                          查看全部角色当前模型
 *   add-feat-model set <角色> [模型ID]           切换；缺省模型 ID 时进入交互选择
 *   add-feat-model unset <角色>                  还原出厂模型
 *
 * 角色：coordinator / developer / auditor / fixer / fixer-flash
 * 模型 ID 必须存在于 `opencode models` 清单（--force 跳过校验）。
 *
 * 行为约束：
 *  - 只在 agent 文件 frontmatter 内整行替换 `model:`，其余字节零改动；
 *  - 首次覆盖时把出厂值记入 ~/.local/state/add-feat/model-overrides.json，unset 据此还原；
 *  - 不留 .bak 文件；修改成功后提示配置重载与运行中任务注意点。
 */
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

export const ROLES = {
  coordinator: "add-feat.md",
  developer: "add-feat-developer.md",
  auditor: "add-feat-auditor.md",
  fixer: "add-feat-fixer.md",
  "fixer-flash": "add-feat-fixer-flash.md",
}

export function agentPath(role) {
  const file = ROLES[role]
  if (!file) throw new Error(`未知角色：${role}（可用：${Object.keys(ROLES).join("、")}）`)
  return file
}

export function agentsDir(home) {
  return join(realHome(home), ".config/opencode/agents")
}

function realHome(home) {
  return home ?? process.env.ADD_FEAT_MODEL_HOME ?? homedir()
}

/** 解析 frontmatter（--- … ---）与其中 model 行；无 frontmatter 或无 model 行返回 null。 */
export function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)
  if (!m) return { frontmatter: null, model: null }
  const modelLine = m[1].match(/^model:[ \t]*(.*?)[ \t]*$/m)
  return { frontmatter: m[0], model: modelLine ? modelLine[1] : null }
}

/** 在 frontmatter 内整行替换 model:；正文中的 model: 字样不动；保持原行尾风格。 */
export function replaceModelLine(content, newModel) {
  if (parseFrontmatter(content).model === null) {
    throw new Error("agent 文件 frontmatter 中没有 model: 行；请人工检查文件结构")
  }
  let done = false
  let inside = false
  const out = content.replace(/^((---)\r?\n)|^model:[ \t].*?(\r?\n)|^(---)/gm, (line) => {
    if (line.startsWith("---") && !inside) { inside = true; return line }
    if (line.startsWith("---") && inside) { inside = false; return line }
    done = true
    return `model: ${newModel}${line.endsWith("\r\n") ? "\r\n" : "\n"}`
  })
  if (!done) throw new Error("未找到可替换的 model: 行")
  return out
}

async function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd} ${args.join(" ")} 失败：${String(stderr).slice(0, 200)}`))
      else resolve(String(stdout))
    })
  })
}

/** 解析 `opencode models` 输出（每行一个 provider/model）。空输出视为不可解析并报错。 */
export async function listModels(run = () => runCmd("opencode", ["models"])) {
  const out = await run()
  const models = out.split("\n").map((s) => s.trim()).filter((s) => s && s.includes("/"))
  if (models.length === 0) throw new Error("无法从 `opencode models` 获取可用模型清单；请确认 opencode 在 PATH 且已连接 provider")
  return models
}

/** 模型 ID 必须在清单内；--force 跳过。非法时返回 { suggestions } 供人挑选。 */
export function validateModelId(modelId, models, force = false) {
  if (force) return true
  if (models.includes(modelId)) return true
  const lower = modelId.toLowerCase()
  const suggestions = models.filter((m) => m.toLowerCase().includes(lower.split("/").pop()) || lower.includes(m.split("/").pop())).slice(0, 5)
  const err = new Error(`模型 ${modelId} 不在当前可用清单中${suggestions.length ? `；相似候选：${suggestions.join("、")}` : "；用 \`opencode models\` 查看全部可用 ID"}`)
  err.suggestions = suggestions
  throw err
}

const OVERRIDE_FILE = join(".local/state/add-feat", "model-overrides.json")

export async function readOverrides(home) {
  try {
    return JSON.parse(await readFile(join(realHome(home), OVERRIDE_FILE), "utf8"))
  } catch {
    return {}
  }
}

async function writeOverrides(home, ov) {
  const target = join(realHome(home), OVERRIDE_FILE)
  await mkdir(join(target, ".."), { recursive: true })
  await writeFile(target, JSON.stringify(ov, null, 2) + "\n")
  await rm(target + ".tmp", { force: true }).catch(() => {})
}

async function writeAgentAtomic(file, content) {
  const tmp = file + ".tmp"
  await writeFile(tmp, content)
  await rename(tmp, file)
}

/** set：校验 → 替换 → 记录出厂值。文件先写临时再改名，避免半写状态。
 *  opts：home（测试注入）、catalog（测试注入的清单文本）、force（跳过校验）。 */
export async function setModel(role, modelId, opts = {}) {
  const home = realHome(opts.home)
  const file = join(agentsDir(home), agentPath(role))
  let current
  try {
    current = await readFile(file, "utf8")
  } catch {
    throw new Error(`未找到 agent 文件：${file}（请确认 add-feat 的 agent 已安装到 ~/.config/opencode/agents）`)
  }
  if (!opts.force) {
    const models = opts.catalog !== undefined ? await listModels(async () => opts.catalog) : await listModels()
    validateModelId(modelId, models, false)
  }
  const from = parseFrontmatter(current).model
  if (from === modelId) return { changed: false, from, to: modelId }
  const next = replaceModelLine(current, modelId)
  await writeAgentAtomic(file, next)
  const ov = await readOverrides(home)
  if (!ov[role]) ov[role] = { original: from, since: new Date().toISOString() }
  ov[role].current = modelId
  await writeOverrides(home, ov)
  return { changed: true, from, to: modelId }
}

/** unset：按覆盖记录还原出厂模型并清除该角色记录。 */
export async function unsetModel(role, opts = {}) {
  const home = realHome(opts.home)
  const ov = await readOverrides(home)
  if (!ov[role]?.original) throw new Error(`${role} 没有覆盖记录，当前已是出厂模型`)
  const file = join(agentsDir(home), agentPath(role))
  const current = await readFile(file, "utf8")
  const restored = ov[role].original
  const next = replaceModelLine(current, restored)
  await writeAgentAtomic(file, next)
  delete ov[role]
  await writeOverrides(home, ov)
  return { restored }
}

/** show：全部角色当前模型 + 覆盖状态 + 是否仍在可用清单。 */
export async function showModels(opts = {}) {
  const home = realHome(opts.home)
  const models = opts.catalog !== undefined ? await listModels(async () => opts.catalog) : await listModels()
  const ov = await readOverrides(home)
  const rows = []
  for (const role of Object.keys(ROLES)) {
    let model = null
    let missing = false
    try {
      model = parseFrontmatter(await readFile(join(agentsDir(home), agentPath(role)), "utf8")).model
    } catch {
      missing = true
    }
    rows.push({
      role,
      model,
      missing,
      overridden: Boolean(ov[role]?.original),
      original: ov[role]?.original ?? null,
      available: model ? models.includes(model) : false,
    })
  }
  return rows
}

// —— 交互选择器：仅 TTY 下使用；逐键过滤，回车确认 ——
async function pickModel(models, role) {
  if (!process.stdin.isTTY) {
    console.error("非交互环境无法弹出选择器；请显式传入模型 ID，例如：add-feat-model set " + role + " zhipuai-coding-plan/glm-5.3-flash")
    process.exit(1)
  }
  const rl = createInterface({ input: process.stdin, escapeCodeTimeout: 50 })
  process.stdin.setRawMode?.(true)
  let filter = ""
  const render = () => {
    process.stdout.write("\x1b[2J\x1b[H")
    const hits = models.filter((m) => m.toLowerCase().includes(filter.toLowerCase()))
    console.log(`为 ${role} 选择模型（输入过滤，回车选中第一项，Esc/Ctrl+C 取消）：`)
    hits.slice(0, 15).forEach((m, i) => console.log(`  ${i + 1}  ${m}`))
    console.log(`  匹配 ${hits.length} 个 > ${filter}`)
    return hits
  }
  let hits = render()
  return new Promise((resolve) => {
    const onKey = (ch) => {
      if (ch === "\x03" || ch === "\x1b") { cleanup(); return resolve(null) }
      if (ch === "\r" || ch === "\n") { cleanup(); return resolve(hits[0] ?? null) }
      if (ch === "\x7f") filter = filter.slice(0, -1)
      else if (ch >= " ") filter += ch
      hits = render()
    }
    const cleanup = () => {
      process.stdin.setRawMode?.(false)
      process.stdin.removeListener("data", onKey)
      rl.close()
      process.stdout.write("\x1b[2J\x1b[H")
    }
    process.stdin.on("data", onKey)
  })
}

const RELOAD_HINT = "\n已写入。注意：运行中的子代理不受影响，下一个子代理生效；子代理运行中切换会造成同阶段混用两个模型。若未自动重载请执行：opencode service restart"

function printUsage() {
  console.log(`用法：
  add-feat-model show                    查看全部角色当前模型
  add-feat-model set <角色> [模型ID]     切换；缺省模型 ID 进入交互选择（支持 --force 跳过清单校验）
  add-feat-model unset <角色>            还原出厂模型

角色：${Object.keys(ROLES).join("、")}`)
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes("--force")
  const positional = args.filter((a) => !a.startsWith("--"))
  const [cmd, role, modelId] = positional
  if (cmd === "show") {
    const rows = await showModels({})
    console.log("角色            当前模型                                  状态")
    for (const r of rows) {
      const tag = r.missing ? "⚠ agent 文件缺失" : r.available ? (r.overridden ? `已覆盖（出厂 ${r.original}）` : "出厂") : "⚠ 模型不在当前可用清单"
      console.log(`${r.role.padEnd(15)} ${(r.model ?? "-").padEnd(41)} ${tag}`)
    }
    return
  }
  if (cmd === "set") {
    if (!ROLES[role]) { printUsage(); process.exit(1) }
    let target = modelId
    if (!target) {
      const models = await listModels()
      target = await pickModel(models, role)
      if (!target) { console.log("已取消"); return }
    }
    const r = await setModel(role, target, { force })
    if (!r.changed) { console.log(`${role} 已是 ${r.to}，零改动`); return }
    console.log(`${role}: ${r.from} → ${r.to}${RELOAD_HINT}`)
    return
  }
  if (cmd === "unset") {
    if (!ROLES[role]) { printUsage(); process.exit(1) }
    const r = await unsetModel(role)
    console.log(`${role} 已还原出厂模型${RELOAD_HINT}`)
    return
  }
  printUsage()
  process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith("add-feat-model.mjs")) {
  main().catch((e) => {
    console.error(String(e.message ?? e))
    process.exit(1)
  })
}
