/** 过程文档规则：渲染与校验（纯逻辑）。
 * 规则来源是"协调者从项目 AGENTS.md 提取、随计划冻结"的提案——插件不内置任何
 * 特定项目的约定，只提供默认方案兜底。写入由 index.ts 的 emitDoc 执行。 */

export interface DocRules {
  /** 任务目录（仓库相对，模板变量 {task} {date}）。 */
  dir: string
  /** plan 文件名（目录内，round 恒为 1）。 */
  plan: string
  /** dev 文件名（可含 {round}）。 */
  dev: string
  /** audit 文件名（可含 {round}）。 */
  audit: string
  /** delivery 文件名（可选，目录内）。 */
  delivery?: string | null
  /** 任务 README 文件名（可选，目录内）。 */
  taskReadme?: string | null
  /** 协作索引（可选，仓库相对模板，如 docs/cowork/README.md）。 */
  index?: string | null
  /** 规则来源说明（展示给用户，如"项目 docs/AGENTS.md"或"add-feat 默认"）。 */
  note?: string
}

export const DEFAULT_DOC_RULES: DocRules = {
  dir: "docs/cowork/{task}_{date}",
  plan: "plan.v1.r1.{date}.md",
  dev: "dev.v1.r{round}.{date}.md",
  audit: "audit.v1.r{round}.{date}.md",
  delivery: "delivery_v1.{date}.md",
  taskReadme: "README.md",
  index: "docs/cowork/README.md",
  note: "add-feat 内置默认（项目未声明过程文档规则）",
}

const FORBIDDEN_PARTS = new Set([".git", ".opencode", "node_modules", "__pycache__"])

export function safeDocPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("..")) return false
  if (path.includes("{") || path.includes("}")) return false  // 渲染后的路径不得残留占位符
  if (path.includes("\0")) return false
  if (path.includes("\0")) return false
  const parts = path.split("/")
  if (parts.some((p) => p === "" || p === "." || FORBIDDEN_PARTS.has(p))) return false
  return true
}

/** 模板校验：允许 {task}/{date}/{round} 占位符，拒绝其他花括号与不安全路径。 */
export function safeDocTemplate(template: string): boolean {
  return safeDocPath(
    template.replace(/\{(task|date|round)\}/g, "OK"),
  )
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{(task|date|round)\}/g, (_, key) => vars[key] ?? `{${key}}`)
  if (/\{(task|date|round)\}/.test(out)) {
    throw new Error(`模板变量未提供，拒绝渲染字面量路径：${template} → ${out}`)
  }
  return out
}

export interface DocVars {
  task: string
  round: number
  /** 任务目录日期（=任务首次启动日，固定不变；渲染 dir 与 index）。 */
  dirDate: string
  /** 文件日期（=该轮启动日；渲染目录内文件名）。 */
  fileDate: string
}

/** 校验规则本身（模板与静态部分安全；渲染后的路径在写入前再校验一次）。 */
export function validateDocRules(raw: unknown): { rules?: DocRules; error?: string } {
  if (typeof raw !== "object" || raw === null) return { error: "docRules 必须是对象" }
  const r = raw as Record<string, unknown>
  const dir = typeof r.dir === "string" ? r.dir.trim() : ""
  const plan = typeof r.plan === "string" ? r.plan.trim() : ""
  const dev = typeof r.dev === "string" ? r.dev.trim() : ""
  const audit = typeof r.audit === "string" ? r.audit.trim() : ""
  if (!dir || !plan || !dev || !audit) return { error: "docRules 需要 dir/plan/dev/audit" }
  for (const [label, value] of [["dir", dir], ["plan", plan], ["dev", dev], ["audit", audit]] as const) {
    if (!safeDocTemplate(value)) return { error: `docRules.${label} 不是安全的相对路径模板：${value}` }
    if (label !== "dir" && value.includes("/")) return { error: `docRules.${label} 应为目录内文件名，不含 /` }
  }
  for (const key of ["delivery", "taskReadme", "index"] as const) {
    const value = r[key]
    if (value !== undefined && value !== null) {
      if (typeof value !== "string" || !value.trim()) return { error: `docRules.${key} 非法` }
      if (!safeDocTemplate(value.trim())) return { error: `docRules.${key} 不是安全路径：${value}` }
      if (key !== "index" && value.includes("/")) return { error: `docRules.${key} 应为目录内文件名` }
    }
  }
  return {
    rules: {
      dir, plan, dev, audit,
      delivery: typeof r.delivery === "string" ? r.delivery.trim() : null,
      taskReadme: typeof r.taskReadme === "string" ? r.taskReadme.trim() : null,
      index: typeof r.index === "string" ? r.index.trim() : null,
      note: typeof r.note === "string" ? r.note.slice(0, 200) : undefined,
    },
  }
}

/** 按规则渲染某轮各文档的仓库相对路径。 */
export function renderDocPaths(rules: DocRules, vars: DocVars): {
  dir: string
  plan: string
  dev: string
  audit: string
  delivery: string | null
  readme: string | null
  index: string | null
} {
  const dirV: Record<string, string> = { task: vars.task, date: vars.dirDate, round: String(vars.round) }
  const fileV: Record<string, string> = { task: vars.task, date: vars.fileDate, round: String(vars.round) }
  const dir = renderTemplate(rules.dir, dirV)
  const join = (name: string) => `${dir}/${renderTemplate(name, fileV)}`
  return {
    dir,
    plan: join(rules.plan),
    dev: join(rules.dev),
    audit: join(rules.audit),
    delivery: rules.delivery ? join(rules.delivery) : null,
    readme: rules.taskReadme ? join(rules.taskReadme) : null,
    index: rules.index ? renderTemplate(rules.index, dirV) : null,
  }
}

/** 校验任务名（常见规范：不含空格/点/斜杠/下划线；项目可自定义）。
 * 注意不能用 \w——它包含下划线。 */
export function validateTaskSlug(raw: unknown): { slug?: string; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { slug: "task" }
  if (typeof raw !== "string") return { error: "taskSlug 必须是字符串" }
  const slug = raw.trim()
  if (!/^[A-Za-z0-9\u4e00-\u9fff-]+$/.test(slug) || slug.length > 40) {
    return { error: `taskSlug 非法（仅中文/字母数字/短横线，≤40 字符）：${slug}` }
  }
  return { slug }
}
