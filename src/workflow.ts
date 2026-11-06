/** add-feat 状态机（v2：过程文档落地）。纯逻辑，无 IO，可单测。
 * 状态由插件服务端持有，模型只能通过 addfeat_gate 的动作推动；非法转移一律拒绝。
 * tampered/exhausted 等"先变更终态再返回失败"的路径必须被调用方无条件落盘（B1 契约）。
 * 过程文档由 deps.emitDoc 服务端写入并登记内容哈希；任何边界发现已登记文档被改动
 * 同样判 tampered——排除区不是盲区。 */

import {
  DEFAULT_DOC_RULES,
  type DocRules,
  renderDocPaths,
  validateDocRules,
  validateTaskSlug,
} from "./docpaths"

export type Phase =
  | "planning"
  | "dev_ready"
  | "dev_running"
  | "audit_ready"
  | "audit_running"
  | "accept_ready"
  | "fix_ready"
  | "fix_running"
  // 终态
  | "accepted"
  | "exhausted"
  | "blocked_human"
  | "tampered"
  | "cancelled"

export const TERMINAL: readonly Phase[] = [
  "accepted",
  "exhausted",
  "blocked_human",
  "tampered",
  "cancelled",
]

export interface Finding {
  id: string
  category: "implementation" | "plan_gap" | "human_decision"
  complexity: "high" | "medium" | "low" | "unknown"
  reason: string
  riskTags?: string[]
  location?: string
}

export interface CheckResult {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdoutTail: string
  stderrTail: string
}

export interface Task {
  id: string
  requirement: string
  maxRepairs: number
  phase: Phase
  createdAt: string
  startDate: string
  /** 当前（或最近一次）交付/修复轮的启动日期；过程文档日期随轮次（常见做法：
   * 文件日期=该轮启动日，任务目录日期固定）。首轮/未开始轮回退 startDate。 */
  roundStartDate?: string
  taskSlug: string
  /** 创建任务的协调者会话；绑定后其他会话只能 status / abort_task（恢复阀）。 */
  ownerSession?: string
  docRules: DocRules
  /** 本任务已写过程文档：仓库相对路径 → 内容 sha256（摘要排除 + 完整性复核）。 */
  processOutputs: Record<string, string>
  plan?: {
    summary: string
    allowedPaths: string[]
    testCommands: string[]
  }
  baselineDigest?: string
  baselineDirtyCount?: number
  /** 一致性强制范围：scoped=allowedPaths+HEAD（confirm_plan 时冻结）；
   *  缺省 full=冻结早于该机制的任务沿用全域（保证旧任务前后摘要可比）。 */
  digestScope?: "full" | "scoped"
  /** 最近一次观察到的全域摘要（仅用于范围外漂移警告，非强制）。 */
  lastFullDigest?: string
  devStartDigest?: string
  devEndDigest?: string
  auditStartDigest?: string
  auditedDigest?: string
  repairsUsed: number
  findings: Finding[]
  checks: CheckResult[]
  checksDigest?: string
  log: Array<{ at: string; action: string; detail?: string }>
  closedAt?: string
  closeReason?: string
}

export interface Store {
  version: 2
  locationDir: string
  task: Task | null
  history: Array<{ id: string; requirement: string; phase: Phase; closedAt: string }>
}

export type GateResult =
  | { ok: true; phase: Phase; task: Task; message: string }
  | { ok: false; error: string }

export const MIN_REPAIRS = 1
export const MAX_REPAIRS = 8
export const DEFAULT_REPAIRS = 4

/** 摘要排除集：start_task 必须按“新任务”视角（空集）计算基线。
 * 旧任务的过程文档排除集随其移入 history 失效；若沿用旧排除集，
 * confirm_plan 时这些未跟踪旧文档会被重新计入摘要，必然误判 tampered
 * （真实事故：people-rec 2026-11-02，澄清期零文件变更仍被误杀）。 */
export function digestExclusionsFor(action: string, task: Task | null): string[] {
  if (action === "start_task") return []
  return Object.keys(task?.processOutputs ?? {})
}

export function clampRepairs(value: number | undefined, fallback: number): number {
  const raw = typeof value === "number" && Number.isInteger(value) ? value : fallback
  return Math.min(MAX_REPAIRS, Math.max(MIN_REPAIRS, raw))
}

function err(error: string): GateResult {
  return { ok: false, error }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** 校验审计问题清单：编号唯一必填，分类/复杂度/理由受限。 */
export function validateFindings(raw: unknown): { findings?: Finding[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "需要至少一条问题（findings 非空数组）" }
  const ids = new Set<string>()
  const findings: Finding[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { error: "findings 项必须是对象" }
    const f = item as Record<string, unknown>
    const id = text(f.id)
    if (!id || ids.has(id)) return { error: "问题 id 缺失或重复" }
    ids.add(id)
    const category = f.category
    if (category !== "implementation" && category !== "plan_gap" && category !== "human_decision") {
      return { error: `问题 ${id} 的 category 必须是 implementation|plan_gap|human_decision` }
    }
    const complexity = f.complexity
    if (complexity !== "high" && complexity !== "medium" && complexity !== "low" && complexity !== "unknown") {
      return { error: `问题 ${id} 的 complexity 必须是 high|medium|low|unknown` }
    }
    const reason = text(f.reason)
    if (!reason) return { error: `问题 ${id} 缺少 reason` }
    findings.push({
      id,
      category,
      complexity,
      reason,
      riskTags: Array.isArray(f.riskTags) ? f.riskTags.filter((x): x is string => typeof x === "string") : [],
      location: text(f.location) || undefined,
    })
  }
  return { findings }
}

export interface GateDeps {
  now(): string
  newId(): string
  /** 当前工作区摘要（已排除本任务过程文档）；无仓库或计算失败返回 null。 */
  digest(): string | null
  /** 服务端执行已确认计划的测试命令（含执行后摘要）。 */
  runChecks(task: Task): Promise<{ checks: CheckResult[]; digest: string | null }>
  /** 服务端写入过程文档并登记哈希（实现见 index.ts；抛错=写入失败）。 */
  emitDoc(kind: "plan" | "dev" | "audit" | "delivery" | "readme" | "index", round: number, content: string): Promise<void>
  /** 补写前核验旧正文哈希并在仓库外保存持久备份；失败不得覆盖原件。 */
  archiveDelivery(path: string, expectedHash: string): Promise<string>
  /** 已登记过程文档是否完好（存在且哈希一致）。 */
  processOutputsIntact(task: Task): boolean
  /** 本地时区日期 YYYY-MM-DD（过程文档日期用；toISOString 是 UTC，跨时区会错日）。 */
  localDate(): string
}

export interface GateInput {
  action: string
  /** 由插件从工具执行上下文注入（模型输入不含此字段）。 */
  sessionId?: string
  /** extend_budget 专用：追加轮数（1–8）与用户原话（人工授权留痕）。 */
  additionalRounds?: unknown
  userQuote?: unknown
  requirement?: unknown
  maxRepairs?: unknown
  taskSlug?: unknown
  planSummary?: unknown
  allowedPaths?: unknown
  testCommands?: unknown
  planDocument?: unknown
  docRules?: unknown
  summary?: unknown
  report?: unknown
  deliveryPath?: unknown
  verdict?: unknown
  findings?: unknown
  reason?: unknown
}

export async function transition(store: Store, input: GateInput, deps: GateDeps): Promise<GateResult> {
  const task = store.task
  const action = input.action

  if (action === "status") {
    if (!task) return err("没有进行中的 add-feat 任务；先用 start_task 创建")
    return { ok: true, phase: task.phase, task, message: "当前任务状态" }
  }

  if (action === "start_task") {
    if (task && !TERMINAL.includes(task.phase)) {
      return err(`已有进行中任务（${task.phase}）；先完成、中止或取消`)
    }
    const requirement = text(input.requirement)
    if (requirement.length < 5) return err("requirement 太短，无法开始")
    const { slug, error: slugError } = validateTaskSlug(input.taskSlug)
    if (slugError || !slug) return err(slugError || "taskSlug 非法")
    const maxRepairs = clampRepairs(input.maxRepairs as number | undefined, DEFAULT_REPAIRS)
    const digest = deps.digest()
    if (!digest) return err("当前目录不是可用 git 仓库；add-feat 需要 git 工作区")
    const now = deps.now()
    store.task = {
      id: deps.newId(),
      requirement,
      maxRepairs,
      phase: "planning",
      createdAt: now,
      startDate: now.slice(0, 10),
      taskSlug: slug,
      ownerSession: text(input.sessionId) || undefined,
      docRules: DEFAULT_DOC_RULES,
      processOutputs: {},
      baselineDigest: digest,
      baselineDirtyCount: countDirty(digest),
      repairsUsed: 0,
      findings: [],
      checks: [],
      log: [{ at: now, action: "start_task", detail: `maxRepairs=${maxRepairs} slug=${slug}` }],
    }
    return ok(store, `任务已创建（planning，slug=${slug}${store.task.ownerSession ? "，已绑定本会话" : ""}）；澄清需求后 confirm_plan`)
  }

  if (!task) return err("没有进行中任务；先 start_task")

  if (TERMINAL.includes(task.phase) && action !== "extend_budget" && action !== "revise_delivery" && action !== "append_audit") {
    return err(`任务已结束（${task.phase}）；不能继续操作。结论与日志保留在状态文件`)
  }

  // 会话绑定：除只读 status 与恢复阀 abort_task 外，状态变更仅限创建任务的会话。
  if (action !== "abort_task" && task.ownerSession && (input.sessionId ?? "") !== task.ownerSession) {
    return err(
      `任务由其他会话创建并绑定（${task.ownerSession.slice(0, 10)}…）；` +
        "本会话只能查看状态或 abort_task 中止。如需接管：回原会话继续，或先 abort 再重开任务",
    )
  }

  switch (action) {
    case "revise_delivery": {
      if (task.phase !== "accepted") return err("revise_delivery 仅用于 accepted 任务的文档补写")
      const report = text(input.report)
      const quote = text(input.userQuote)
      const reason = text(input.reason)
      if (!report || quote.length < 4 || reason.length < 3) {
        return err("补写需要完整 report、用户授权原话 userQuote 与修订理由 reason")
      }
      const round = task.repairsUsed + 1
      const paths = renderDocPaths(task.docRules, { task: task.taskSlug, round, dirDate: task.startDate, fileDate: task.roundStartDate ?? task.startDate })
      const target = text(input.deliveryPath)
      if (!paths.delivery || target !== paths.delivery || !Object.hasOwn(task.processOutputs, target)) {
        return err("deliveryPath 必须精确指向本任务按冻结规则生成且已登记的 delivery；不允许新路径或新版本")
      }
      const digest = deps.digest()
      if (!digest || digest !== task.auditedDigest) {
        return err("受检工作区已变化或摘要不可用，不能补写为同一验收成果；原 accepted 历史结论保留，请人工核对")
      }
      if (!deps.processOutputsIntact(task)) {
        return err("已登记过程文档不完整或已变化，拒绝覆盖及重登记；原 accepted 历史结论保留，请人工核对")
      }
      const previousHash = task.processOutputs[target]
      let archive = ""
      const at = deps.now()
      try {
        archive = await deps.archiveDelivery(target, previousHash)
        await deps.emitDoc("delivery", round, deliveryDraft(task, report, { at, reason, quote, previousHash, archive }))
      } catch (e) {
        return err(`交付文档补写失败；验收结论未改变${archive ? `，旧正文备份：${archive}` : ""}：${String(e)}`)
      }
      push(task, deps, "revise_delivery", JSON.stringify({ path: target, reason, userQuote: quote, previousHash, archive }))
      return ok(store, `delivery 已补写：${target}；旧正文备份：${archive}；accepted、轮次与原验收证据不变，未重新测试或人工验收`)
    }

    case "cancel_task": {
      if (task.phase !== "planning") return err("planning 之后请用 abort_task 中止")
      close(store, task, deps, "cancelled", text(input.reason) || "用户取消")
      return ok(store, "任务已取消")
    }

    case "abort_task": {
      const reason = text(input.reason)
      if (reason.length < 3) return err("abort_task 需要 reason")
      close(store, task, deps, "cancelled", `中止：${reason}`)
      push(task, deps, "abort_task", reason)
      return ok(store, "任务已中止（cancelled）；可重新开任务")
    }

    case "extend_budget": {
      // 人工追加修复轮数：仅当用户明确要求（userQuote 原话留痕，提示层纪律）。
      // exhausted 可复活为 fix_ready；accepted/tampered/cancelled/blocked_human 不适用。
      const blocked = (["accepted", "tampered", "cancelled", "blocked_human"] as const)
      if ((blocked as readonly string[]).includes(task.phase)) {
        return err(`任务状态 ${task.phase} 不适用追加轮数`)
      }
      const add = input.additionalRounds
      if (typeof add !== "number" || !Number.isInteger(add) || add < 1 || add > 8) {
        return err("additionalRounds 必须是 1–8 的整数")
      }
      if (task.maxRepairs + add > 16) {
        return err(`追加后总轮数 ${task.maxRepairs + add} 超过上限 16`)
      }
      const quote = text(input.userQuote)
      if (quote.length < 4) return err("userQuote 必须原样引用用户要求追加的原话")
      const resurrected = task.phase === "exhausted"
      if (resurrected) {
        if (task.findings.length === 0) return err("exhausted 状态缺少待修问题，无法恢复")
        task.phase = "fix_ready"
        task.closedAt = undefined
        task.closeReason = undefined
      }
      task.maxRepairs += add
      push(task, deps, "extend_budget", `+${add} → ${task.maxRepairs}；用户原话：“${quote.slice(0, 80)}”`)
      return ok(
        store,
        resurrected
          ? `预算已追加 ${add} 轮（总 ${task.maxRepairs}）；任务已从 exhausted 恢复为 fix_ready，可继续修复`
          : `预算已追加 ${add} 轮（总 ${task.maxRepairs}）；当前阶段不变`,
      )
    }

    case "append_audit": {
      // 终态后复核登记：accepted/exhausted 任务把事后整体复核（如限定范围技术复核、
      // 失败清单）按规范归档为下一空位的 audit 记录。不改变终态、关闭时间、轮次与历史结论。
      if (task.phase !== "accepted" && task.phase !== "exhausted") {
        return err("append_audit 仅用于 accepted/exhausted 任务的终态后复核登记")
      }
      const report = text(input.report)
      if (!report) {
        return err("append_audit 需要完整报告正文 report（按《过程文档撰写规范》§4），并在正文明确标注记录性质（如：非独立审计、已复现/静态分析、未完成整体验收）")
      }
      const reason = text(input.reason)
      if (reason.length < 4) {
        return err("append_audit 需要 reason 说明登记背景（≥4 字，如：终态后整体技术复核，非独立审计）")
      }
      if (!deps.processOutputsIntact(task)) {
        return err("已登记过程文档不完整或已变化，拒绝追加记录；请先人工核对任务目录")
      }
      // 编号取下一个空位：从 repairsUsed+1 起找第一个未登记的 audit 路径（与 emitDoc 同一日期来源）
      const fileDate = task.roundStartDate ?? task.startDate
      let round = task.repairsUsed + 1
      let target = ""
      for (let i = 0; i < 10; i++) {
        const candidate = renderDocPaths(task.docRules, { task: task.taskSlug, round, dirDate: task.startDate, fileDate }).audit
        if (!candidate) return err("项目规则未配置 audit 文档")
        if (!Object.hasOwn(task.processOutputs, candidate)) {
          target = candidate
          break
        }
        round += 1
      }
      if (!target) return err("连续 10 个轮次编号均被占用；请人工核查任务目录")
      try {
        await deps.emitDoc("audit", round, report)
        const paths = renderDocPaths(task.docRules, { task: task.taskSlug, round, dirDate: task.startDate, fileDate })
        if (paths.readme) {
          await deps.emitDoc("readme", round, readmeContent(task, `终态 ${task.phase}；${reason}`))
        }
      } catch (e) {
        return err(`audit 记录写入失败（可重试 append_audit）：${String(e)}`)
      }
      push(task, deps, "append_audit", `r${round} ${reason.slice(0, 80)}`)
      return ok(store, `终态后复核记录已登记：${target}（r${round}）；终态 ${task.phase}、关闭时间与历史结论不变，记录性质以正文标注为准`)
    }

    case "confirm_plan": {
      if (task.phase !== "planning") return err(`confirm_plan 只能在 planning，当前 ${task.phase}`)
      const summary = text(input.planSummary)
      const paths = stringArray(input.allowedPaths)
      const commands = stringArray(input.testCommands)
      if (summary.length < 10) return err("planSummary 太短")
      if (paths.length === 0) return err("allowedPaths 不能为空")
      if (commands.length === 0) return err("testCommands 不能为空（至少一条可执行验收命令）")
      const digest = deps.digest()
      if (!digest) return err("git 摘要不可用，拒绝确认")
      let rebased = false
      if (task.baselineDigest && stripDirty(digest) !== stripDirty(task.baselineDigest)) {
        // 规划期软重置：此时任务尚无任何代码依赖基线（开发未开始），漂移不再终态作废
        // （真实事故：people-rec 2026-11-02 澄清 2 小时因无关变化被误杀）。
        // 记录漂移并把基线重捕获为冻结时状态；过程文档完整性仍独立强制（见下）。
        rebased = true
        const prevDirty = task.baselineDirtyCount ?? countDirty(task.baselineDigest)
        task.baselineDigest = digest
        task.baselineDirtyCount = countDirty(digest)
        push(task, deps, "baseline_rebase", `澄清期间工作区变化（dirty ${prevDirty}→${task.baselineDirtyCount}），基线重捕获为冻结时状态`)
      }
      if (!deps.processOutputsIntact(task)) {
        close(store, task, deps, "tampered", "过程文档在 planning 期间被修改")
        return err("已登记的过程文档被修改；任务标记 tampered，请人工检查")
      }
      let rules = task.docRules
      if (input.docRules !== undefined) {
        const parsed = validateDocRules(input.docRules)
        if (parsed.error || !parsed.rules) return err(parsed.error || "docRules 非法")
        rules = parsed.rules
      }
      const planDocument = text(input.planDocument)
      if (planDocument.length > 200_000) return err("planDocument 超过 200KB 上限")
      task.docRules = rules
      task.plan = { summary, allowedPaths: paths, testCommands: commands }
      // 范围随计划冻结：此后一致性强制 = allowedPaths + HEAD；范围外变化只警告。
      task.digestScope = "scoped"
      const paths2 = renderDocPaths(rules, { task: task.taskSlug, round: 1, dirDate: task.startDate, fileDate: task.startDate })
      try {
        await deps.emitDoc("plan", 1, planDocument || `# 计划（摘要）\n\n${summary}\n- allowedPaths: ${paths.join(", ")}- testCommands: ${commands.join("；")}`)
        if (paths2.readme) {
          await deps.emitDoc("readme", 1, readmeContent(task, "计划已确认，开发中"))
        }
        if (paths2.index) {
          await deps.emitDoc("index", 1, `- [${task.taskSlug}](${task.taskSlug}_${task.startDate}/)（${task.startDate}）\n`)
        }
      } catch (e) {
        return err(`过程文档写入失败（可重试 confirm_plan）：${String(e)}`)
      }
      task.phase = "dev_ready"
      push(task, deps, "confirm_plan", `paths=${paths.join(",")} docs=${paths2.dir}/`)
      return ok(
        store,
        `计划已冻结（dev_ready）${rebased ? "；注意：澄清期间工作区有变化，基线已重置为冻结时状态并记录（需向用户说明）" : ""}；一致性强制范围=allowedPaths+HEAD（范围外变化仅警告）；过程文档落地于 ${paths2.dir}/；begin_dev 后启动开发者`,
      )
    }

    case "begin_dev": {
      if (task.phase !== "dev_ready") return err(`begin_dev 只能在 dev_ready，当前 ${task.phase}`)
      const digest = deps.digest()
      if (!digest) return err("git 摘要不可用")
      task.devStartDigest = digest
      task.roundStartDate = deps.localDate()
      task.phase = "dev_running"
      push(task, deps, "begin_dev")
      return ok(store, "开发阶段开始（dev_running）；现在可以启动 add-feat-developer")
    }

    case "end_dev": {
      if (task.phase !== "dev_running") return err(`end_dev 只能在 dev_running，当前 ${task.phase}`)
      const digest = deps.digest()
      if (!digest) return err("git 摘要不可用")
      if (digest === task.devStartDigest) {
        return err("工作区没有任何变化；若确无代码改动，请人工取消任务而不是空转审计")
      }
      if (!deps.processOutputsIntact(task)) {
        close(store, task, deps, "tampered", "过程文档在开发期间被修改")
        return err("已登记的过程文档被修改；任务标记 tampered，请人工检查")
      }
      const summary = text(input.summary) || text(input.report)
      if (summary.length < 120) {
        return err(
          `dev 交付报告过于单薄（${summary.length} 字）：按《过程文档撰写规范》§3 补全（结论与依据/变更明细/红绿证据/测试资产变更/遗留风险）后再 end_dev；纯文档小任务允许简化但须写明依据与验证`,
        )
      }
      try {
        await deps.emitDoc("dev", task.repairsUsed + 1, summary)
      } catch (e) {
        return err(`dev 过程文档写入失败（可重试 end_dev）：${String(e)}`)
      }
      task.devEndDigest = digest
      task.phase = "audit_ready"
      push(task, deps, "end_dev", summary.slice(0, 80) || undefined)
      return ok(store, "开发交付（audit_ready）；先 run_checks 取得可信测试证据，再 begin_audit")
    }

    case "run_checks": {
      if (task.phase !== "audit_ready" && task.phase !== "accept_ready") {
        return err(`run_checks 只能在 audit_ready/accept_ready，当前 ${task.phase}`)
      }
      if (!task.plan) return err("缺少已确认计划")
      const { checks, digest } = await deps.runChecks(task)
      task.checks = checks
      task.checksDigest = digest
      const failed = checks.filter((c) => c.exitCode !== 0)
      push(task, deps, "run_checks", `${checks.length} 条命令，${failed.length} 条失败`)
      return {
        ok: true,
        phase: task.phase,
        task,
        message: failed.length === 0 ? "全部命令通过" : `${failed.length} 条命令失败`,
      }
    }

    case "begin_audit": {
      if (task.phase !== "audit_ready") return err(`begin_audit 只能在 audit_ready，当前 ${task.phase}`)
      const digest = deps.digest()
      if (!digest) return err("git 摘要不可用")
      if (task.checks.length === 0 || task.checksDigest !== digest) {
        return err("没有与当前工作区一致的可信测试证据；先 run_checks")
      }
      task.auditStartDigest = digest
      task.phase = "audit_running"
      push(task, deps, "begin_audit")
      return ok(store, "审计阶段开始（audit_running）；现在可以启动 add-feat-auditor")
    }

    case "end_audit": {
      if (task.phase !== "audit_running") return err(`end_audit 只能在 audit_running，当前 ${task.phase}`)
      const digest = deps.digest()
      if (!digest) return err("git 摘要不可用")
      if (digest !== task.auditStartDigest) {
        close(store, task, deps, "tampered", "审计期间工作区被修改")
        return err("审计期间代码发生变化（审计者必须只读）；任务标记 tampered，请人工检查")
      }
      if (!deps.processOutputsIntact(task)) {
        close(store, task, deps, "tampered", "过程文档在审计期间被修改")
        return err("已登记的过程文档被修改；任务标记 tampered，请人工检查")
      }
      const round = task.repairsUsed + 1
      const report = text(input.report) || text(input.summary)
      if (!report) {
        return err("审计者必须提供完整报告正文（report）：纯 JSON 结论不足以归档——请审计者按《过程文档撰写规范》§4 补充正文（结论与独立性/核验方法/上轮复核表/问题详情/已核验项/后续动作）后重新提交结论")
      }
      // 先完成全部校验并更新 findings，再写文档：README 必须反映本轮最新问题清单
      // （否则首轮 README 缺"未关闭问题"节、通过轮残留上轮旧问题）。
      const verdict = input.verdict
      if (verdict === "pass") {
        if (Array.isArray(input.findings) && input.findings.length > 0) {
          return err("pass 不能附带未关闭问题；有问题必须 verdict=fail")
        }
        const green = task.checks.length > 0 && task.checks.every((c) => c.exitCode === 0)
        if (!green) return err("审计通过必须以全部测试命令绿色为前提；先 run_checks 且全部通过")
        if (task.checksDigest !== digest) {
          return err("测试证据与当前工作区不一致；代码变动后须重新 run_checks")
        }
      } else if (verdict === "fail") {
        const { findings, error } = validateFindings(input.findings)
        if (error || !findings) return err(error || "findings 非法")
        task.findings = findings
      } else {
        return err("verdict 必须是 pass 或 fail")
      }
      try {
        await deps.emitDoc("audit", round, report)
        const paths = renderDocPaths(task.docRules, { task: task.taskSlug, round, dirDate: task.startDate, fileDate: task.roundStartDate ?? task.startDate })
        if (paths.readme) {
          await deps.emitDoc("readme", round, readmeContent(task, "审计进行中"))
        }
      } catch (e) {
        return err(`audit 过程文档写入失败（可重试 end_audit）：${String(e)}`)
      }
      if (verdict === "pass") {
        task.auditedDigest = digest
        task.findings = []
        task.phase = "accept_ready"
        push(task, deps, "end_audit", "pass")
        return ok(store, "审计通过（accept_ready）；final_accept 前插件会重新独立执行测试")
      }
      const needsHuman = task.findings.some((f) => f.category !== "implementation")
      if (needsHuman) {
        close(store, task, deps, "blocked_human", "存在 plan_gap/human_decision 问题")
        return ok(store, "存在计划/人工决策问题（blocked_human）；请用户处理后重新开任务")
      }
      if (task.repairsUsed >= task.maxRepairs) {
        close(store, task, deps, "exhausted", `修复预算耗尽（${task.maxRepairs}）`)
        return ok(store, "修复预算已耗尽（exhausted）；必须如实输出未通过总结")
      }
      task.phase = "fix_ready"
      push(task, deps, "end_audit", `fail，${task.findings.length} 条问题`)
      return ok(store, `审计未通过（fix_ready）；按复杂度选择 add-feat-fixer 或 add-feat-fixer-flash`)
    }

    case "begin_fix": {
      if (task.phase !== "fix_ready") return err(`begin_fix 只能在 fix_ready，当前 ${task.phase}`)
      if (task.repairsUsed >= task.maxRepairs) {
        close(store, task, deps, "exhausted", `修复预算耗尽（${task.maxRepairs}）`)
        return err("修复预算已耗尽；必须输出未通过总结（exhausted）")
      }
      task.repairsUsed += 1
      task.roundStartDate = deps.localDate()
      task.phase = "fix_running"
      push(task, deps, "begin_fix", `第 ${task.repairsUsed}/${task.maxRepairs} 轮`)
      return ok(store, `修复轮 ${task.repairsUsed}/${task.maxRepairs}（fix_running）`)
    }

    case "end_fix": {
      if (task.phase !== "fix_running") return err(`end_fix 只能在 fix_running，当前 ${task.phase}`)
      const summary = text(input.summary) || text(input.report)
      if (summary.length < 120) {
        return err(
          `修复报告过于单薄（${summary.length} 字）：按《过程文档撰写规范》§3 补全（逐条处理记录/红绿证据/测试资产变更映射/遗留风险）后再 end_fix；纯文档小任务允许简化但须写明依据与验证`,
        )
      }
      try {
        await deps.emitDoc("dev", task.repairsUsed + 1 === 1 ? 1 : task.repairsUsed + 1, summary)
      } catch (e) {
        return err(`dev 过程文档写入失败（可重试 end_fix）：${String(e)}`)
      }
      task.phase = "audit_ready"
      task.checks = []
      task.checksDigest = undefined
      push(task, deps, "end_fix", summary.slice(0, 80) || undefined)
      return ok(store, "修复交付（audit_ready）；重新 run_checks 再 begin_audit")
    }

    case "final_accept": {
      if (task.phase !== "accept_ready") return err(`final_accept 只能在 accept_ready，当前 ${task.phase}`)
      const digest = deps.digest()
      if (!digest) return err("git 摘要不可用")
      if (digest !== task.auditedDigest) {
        close(store, task, deps, "tampered", "审计通过后代码又被修改")
        return err("审计通过后代码发生变化；验收无效（tampered），请人工检查")
      }
      if (!deps.processOutputsIntact(task)) {
        close(store, task, deps, "tampered", "过程文档在验收前被修改")
        return err("已登记的过程文档被修改；任务标记 tampered，请人工检查")
      }
      // 正文由协调者综合工程证据撰写；插件仅校验存在性，不冒充内容质量审计。
      const deliveryReport = text(input.report)
      if (task.docRules.delivery && !deliveryReport) {
        return err("配置了 delivery：请按 delivery撰写规范.md 综合适用 plan、全部轮次 dev/audit 与实际代码，在 final_accept.report 提供完整交付正文；不能只用需求摘要和命令清单")
      }
      const { checks, digest: afterChecks } = await deps.runChecks(task)
      task.checks = checks
      if (afterChecks !== null && afterChecks !== task.auditedDigest) {
        close(store, task, deps, "tampered", "最终验收测试期间代码被修改")
        return err("验收测试执行期间代码发生变化；验收无效（tampered），请人工检查")
      }
      const failed = checks.filter((c) => c.exitCode !== 0)
      if (failed.length > 0) {
        task.findings = [
          {
            id: "AF-1",
            category: "implementation",
            complexity: "medium",
            reason: `最终验收有 ${failed.length} 条命令失败：${failed.map((c) => c.command).join("；")}`,
          },
        ]
        if (task.repairsUsed >= task.maxRepairs) {
          close(store, task, deps, "exhausted", "验收失败且预算耗尽")
          return ok(store, "验收失败且预算耗尽（exhausted）；输出未通过总结")
        }
        task.phase = "fix_ready"
        push(task, deps, "final_accept", "复检失败，回 fix_ready")
        return ok(store, "最终验收测试未通过，回到 fix_ready 修复 AF-1")
      }
      try {
        const paths = renderDocPaths(task.docRules, { task: task.taskSlug, round: task.repairsUsed + 1, dirDate: task.startDate, fileDate: task.roundStartDate ?? task.startDate })
        if (paths.delivery) {
          await deps.emitDoc("delivery", task.repairsUsed + 1, deliveryDraft(task, deliveryReport))
        }
        if (paths.readme) {
          await deps.emitDoc("readme", task.repairsUsed + 1, readmeContent(task, "AI 验收通过（未经人工确认，未提交）"))
        }
      } catch (e) {
        return err(`delivery 过程文档写入失败（可重试 final_accept）：${String(e)}`)
      }
      close(store, task, deps, "accepted", "审计+复检通过")
      return ok(store, "最终验收通过（accepted）；输出总结，改动未提交，由用户决定合并")
    }

    default:
      return err(`未知动作 ${action}`)
  }
}

/** 任务 README＝导航页：有效计划、轮次报告链、未关闭问题、代码与交付状态。
 *  状态措辞由调用方传入且对应闸门真实阶段；本函数不做状态推断。 */
function readmeContent(task: Task, status: string): string {
  const outputs = Object.keys(task.processOutputs)
  const base = (k: string) => k.split("/").pop() ?? k
  const planKey = outputs.find((k) => /(^|\/)plan\./.test(k))
  const deliveryKey = outputs.find((k) => /(^|\/)delivery/.test(k))
  const devKeys = outputs.filter((k) => /(^|\/)dev\./.test(k))
  const auditKeys = outputs.filter((k) => /(^|\/)audit\./.test(k))
  const lines = [
    `# ${task.taskSlug}`,
    "",
    `- 状态：${status}`,
    `- 任务：${task.id}；修复轮次：${task.repairsUsed}/${task.maxRepairs}`,
    `- 需求：${task.requirement.slice(0, 200)}`,
    `- 有效计划：${planKey ? `[${base(planKey)}](${base(planKey)})` : "（无 plan 文件；批准基线以闸门 confirm_plan 冻结记录为准）"}`,
    `- 文档规则来源：${task.docRules.note ?? "未标注"}`,
    "",
  ]
  const rounds = new Set<number>()
  for (const k of [...devKeys, ...auditKeys]) {
    const m = base(k).match(/\.r(\d+)\./)
    if (m) rounds.add(Number(m[1]))
  }
  const sorted = [...rounds].sort((a, b) => a - b)
  if (sorted.length > 0) {
    lines.push("## 轮次报告", "", "| 轮次 | dev | audit |", "|---|---|---|")
    for (const r of sorted) {
      const d = devKeys.find((k) => base(k).includes(`.r${r}.`))
      const a = auditKeys.find((k) => base(k).includes(`.r${r}.`))
      lines.push(`| r${r} | ${d ? `[dev](${base(d)})` : "—"} | ${a ? `[audit](${base(a)})` : "—"} |`)
    }
    lines.push("")
  }
  if (task.findings.length > 0) {
    lines.push("## 未关闭问题（待修复或待人决策）", "")
    for (const f of task.findings) {
      lines.push(`- **${f.id}**（${f.complexity}${f.category === "implementation" ? "" : ` · ${f.category}`}）：${f.reason.slice(0, 100)}`)
    }
    lines.push("")
  }
  lines.push(
    "## 代码与交付状态",
    "",
    "- 改动未提交、未部署；最新可信证据以各轮 audit 与闸门记录为准。",
    deliveryKey ? `- 交付草稿：[${base(deliveryKey)}](${base(deliveryKey)})（AI 验收通过、未经人工确认）` : "- 交付文档：最终验收通过后生成。",
    "",
    "> add-feat 过程文档由插件服务端写入；人工可直接修改（下一阶段边界会检测到并要求确认）。",
    "",
  )
  return lines.join("\n")
}

function deliveryDraft(task: Task, report: string, revision?: { at: string; reason: string; quote: string; previousHash: string; archive: string }): string {
  return [
    `# ${task.taskSlug} 交付草稿`,
    "",
    "> **状态：AI 验收通过，未经人工确认；代码未提交。** 人工确认后请移除本提示并定稿。",
    "",
    ...(revision ? [
      `> 文档修订时间：${revision.at}；修订说明：${revision.reason}`,
      "> 本次仅重整交付正文，不重跑检查、不改变原验收结论；落盘授权不等于人工验收通过。",
      `> 修订前正文 SHA-256：\`${revision.previousHash}\`；旧正文由插件在仓库外备份。`,
      "",
    ] : []),
    report,
    "",
    revision ? "## 插件附录：原验收证据（非本次重跑）" : "## 插件附录：最终可信复检（服务端生成）",
    "",
    `- 任务：${task.id}；修复轮次：${task.repairsUsed}/${task.maxRepairs}`,
    `- 受检工作区摘要（不是 commit）：\`${task.auditedDigest}\``,
    revision ? `- 以下引用原验收记录（任务关闭时间：${task.closedAt ?? "未记录"}）；本次未重新执行，不代表当前额外验证、人工验收或上线。` : "- 以下为本次 final_accept 的真实执行结果；不替代正文中的按能力验证说明，也不代表人工验收或上线。",
    "",
    ...task.checks.map((c) => `- \`${c.command}\` → 退出码 ${c.exitCode}`),
    "",
  ].join("\n")
}

function ok(store: Store, message: string): GateResult {
  return { ok: true, phase: store.task!.phase, task: store.task!, message }
}

function push(task: Task, deps: GateDeps, action: string, detail?: string) {
  task.log.push({ at: deps.now(), action, detail })
  if (task.log.length > 200) task.log.splice(0, task.log.length - 200)
}

function close(store: Store, task: Task, deps: GateDeps, phase: Phase, reason: string) {
  task.phase = phase
  task.closedAt = deps.now()
  task.closeReason = reason
  store.history.push({ id: task.id, requirement: task.requirement, phase, closedAt: task.closedAt })
  if (store.history.length > 10) store.history.splice(0, store.history.length - 10)
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
}

/** 摘要末尾带 dirty 计数标记（"…|dirty=N"）；剥离后比较内容部分。 */
export function stripDirty(digest: string): string {
  const idx = digest.lastIndexOf("|dirty=")
  return idx === -1 ? digest : digest.slice(0, idx)
}

export function countDirty(digest: string): number {
  const idx = digest.lastIndexOf("|dirty=")
  const n = idx === -1 ? NaN : Number(digest.slice(idx + 7))
  return Number.isInteger(n) ? n : 0
}

/** 权限钩子用的启动判定：目标 agent 是否可在当前阶段启动。 */
export function launchAllowed(
  store: Store,
  callerAgent: string | undefined,
  targetAgent: string,
): { allowed: boolean; reason?: string } {
  const need: Record<string, Phase> = {
    "add-feat-developer": "dev_running",
    "add-feat-auditor": "audit_running",
    "add-feat-fixer": "fix_running",
    "add-feat-fixer-flash": "fix_running",
  }
  if (!need[targetAgent]) return { allowed: true }
  if (callerAgent !== "add-feat") {
    return { allowed: false, reason: "add-feat 工作流角色只能由 add-feat 协调者启动" }
  }
  const task = store.task
  if (!task) return { allowed: false, reason: "没有进行中任务；先 start_task" }
  if (TERMINAL.includes(task.phase)) {
    return { allowed: false, reason: `任务已结束（${task.phase}），不能再启动角色` }
  }
  const required = need[targetAgent]
  if (task.phase !== required) {
    return {
      allowed: false,
      reason: `${targetAgent} 只能在 ${required} 阶段启动；当前 ${task.phase}。请先按协议调用 addfeat_gate`,
    }
  }
  return { allowed: true }
}
