import { describe, expect, test } from "bun:test"
import {
  DEFAULT_REPAIRS,
  TERMINAL,
  type GateDeps,
  type GateInput,
  type Store,
  clampRepairs,
  digestExclusionsFor,
  launchAllowed,
  transition,
  validateFindings,
} from "../src/workflow"
import { renderDocPaths } from "../src/docpaths"
/** 可控依赖：摘要 current、测试成败 failChecks、文档发射记录 docs 均为闭包变量。 */
function makeDeps(opts: { checksFail?: boolean } = {}) {
  const store: Store = { version: 2, locationDir: "/tmp/x", task: null, history: [] }
  const d = {
    current: "base|dirty=0",
    failChecks: opts.checksFail ?? false,
    intact: true,
    docError: null as string | null,
    docs: [] as Array<{ kind: string; round: number; content: string }>,
    archives: [] as Array<{ path: string; hash: string }>,
  }
  const deps: GateDeps = {
    now: () => new Date().toISOString(),
    newId: () => `id-${Math.random().toString(36).slice(2, 8)}`,
    digest: () => d.current,
    runChecks: async (task) => ({
      checks: (task.plan?.testCommands ?? []).map((command) => ({
        command,
        exitCode: d.failChecks ? 1 : 0,
        timedOut: false,
        durationMs: 1,
        stdoutTail: d.failChecks ? "FAILED" : "ok",
        stderrTail: "",
      })),
      digest: d.current,
    }),
    emitDoc: async (kind, round, content) => {
      if (d.docError) throw new Error(d.docError)
      d.docs.push({ kind, round, content })
      // 模拟真实插件：路径由 renderDocPaths 计算并登记（README 导航与空位推导依赖这些键）
      const task = store.task
      if (task) {
        const paths = renderDocPaths(task.docRules, { task: task.taskSlug, round, dirDate: task.startDate, fileDate: task.roundStartDate ?? task.startDate })
        const rel = kind === "index" ? paths.index! : kind === "readme" ? paths.readme! : kind === "delivery" ? paths.delivery! : paths[kind]!
        task.processOutputs[rel] = "synthetic"
      }
    },
    archiveDelivery: async (path: string, hash: string) => {
      d.archives.push({ path, hash })
      return "/state/delivery-revisions/old.json"
    },
    processOutputsIntact: () => d.intact,
    localDate: () => "2026-11-01",
  }
  return Object.assign(deps, { store, d })
}

async function drive(t: GateDeps & { store: Store }, input: GateInput) {
  return transition(t.store, input, t)
}

const DEV_REPORT = "# 本轮交付报告\n\n结论与依据：已按计划完成实现与自测，待独立审计。变更明细与红绿证据、测试资产变更映射及遗留风险见正文各节，此处为满足最短实质要求的占位正文。".repeat(2)
const AUDIT_REPORT = "# 审计报告\n\n结论与独立性：未参与实现的独立审计。核验方法、上轮复核表、问题详情、已核验项与后续动作见正文，此处为满足归档要求的占位正文。".repeat(2)

const start = { action: "start_task", requirement: "实现邮箱验证功能" }
const accept = { action: "final_accept", report: "## 已交付能力\n\n邮箱校验模块已实现，测试证据见下方插件复检附录。\n\n## 限制\n\n尚未人工确认、未部署。" }
const plan = {
  action: "confirm_plan",
  planSummary: "修改 auth 模块新增邮箱校验",
  allowedPaths: ["src/auth/**"],
  testCommands: ["pytest -q"],
}

/** planning → 开发完成（audit_ready），未跑检查。 */
async function toAuditReady(t: ReturnType<typeof makeDeps>) {
  await drive(t, start)
  await drive(t, plan)
  await drive(t, { action: "begin_dev" })
  t.d.current = "dev1|dirty=1"
  await drive(t, { action: "end_dev", summary: DEV_REPORT })
}

/** audit_ready → audit_running（检查全绿）。 */
async function toAuditRunning(t: ReturnType<typeof makeDeps>) {
  await drive(t, { action: "run_checks" })
  await drive(t, { action: "begin_audit" })
}

describe("clampRepairs", () => {
  test("默认与边界", () => {
    expect(clampRepairs(undefined, 4)).toBe(4)
    expect(clampRepairs(0, 4)).toBe(1)
    expect(clampRepairs(99, 4)).toBe(8)
    expect(clampRepairs(3, 4)).toBe(3)
    expect(DEFAULT_REPAIRS).toBe(4)
  })
})

describe("摘要排除集（people-rec 误判 tampered 回归）", () => {
  test("start_task 永远用空集，不沿用上一任务的排除集", async () => {
    const t = makeDeps()
    // 造一个"上一任务"：accepted 且登记多份过程文档
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    await drive(t, accept)
    const prior = t.store.task!
    expect(Object.keys(prior.processOutputs).length).toBeGreaterThanOrEqual(0)
    prior.processOutputs = { "docs/old-plan.md": "h1", "docs/old-dev.md": "h2" }
    // 新任务 start_task：排除集必须是 []，与 confirm_plan 视角一致
    expect(digestExclusionsFor("start_task", prior)).toEqual([])
    expect(digestExclusionsFor("start_task", null)).toEqual([])
    // 其余动作沿用当前任务登记项
    expect(digestExclusionsFor("confirm_plan", prior)).toEqual(["docs/old-plan.md", "docs/old-dev.md"])
    expect(digestExclusionsFor("final_accept", null)).toEqual([])
    // 端到端：上一任务带登记文档时，新任务 planning→confirm_plan 不再误判
    const t2 = makeDeps()
    await toAuditReady(t2)
    await toAuditRunning(t2)
    await drive(t2, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    await drive(t2, accept)
    t2.store.task!.processOutputs = { "docs/old.md": "h" }
    const startAgain = await drive(t2, { ...start, requirement: "people-rec 推荐服务首版" })
    expect(startAgain.ok).toBe(true)
    expect(t2.store.task!.phase).toBe("planning")
    const frozen = await drive(t2, plan)
    expect(frozen.ok).toBe(true)
    expect(t2.store.task!.phase).toBe("dev_ready")
  })
})

describe("happy path", () => {
  test("规划→开发→审计通过→验收", async () => {
    const t = makeDeps()
    expect((await drive(t, start)).ok).toBe(true)
    expect(t.store.task!.phase).toBe("planning")
    expect((await drive(t, plan)).ok).toBe(true)
    expect(t.store.task!.phase).toBe("dev_ready")
    expect((await drive(t, { action: "begin_dev" })).ok).toBe(true)
    t.d.current = "dev1|dirty=1"
    expect((await drive(t, { action: "end_dev", summary: DEV_REPORT })).ok).toBe(true)
    await toAuditRunning(t)
    expect((await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })).ok).toBe(true)
    expect(t.store.task!.phase).toBe("accept_ready")
    expect((await drive(t, accept)).ok).toBe(true)
    expect(t.store.task!.phase).toBe("accepted")
    expect((await drive(t, { action: "begin_fix" })).ok).toBe(false)
  })
})

describe("非法转移与校验", () => {
  test("无任务时动作被拒绝", async () => {
    const t = makeDeps()
    for (const action of ["confirm_plan", "begin_dev", "end_audit", "final_accept", "status"]) {
      const r = await drive(t, { action })
      expect(r.ok).toBe(false)
    }
  })
  test("requirement 太短拒绝", async () => {
    const t = makeDeps()
    expect((await drive(t, { action: "start_task", requirement: "ab" })).ok).toBe(false)
  })
  test("digest 不可用拒绝创建", async () => {
    const t = makeDeps()
    t.digest = () => null
    expect((await drive(t, start)).ok).toBe(false)
  })
  test("confirm_plan 空路径/空命令/短摘要拒绝", async () => {
    const t = makeDeps()
    await drive(t, start)
    expect((await drive(t, { ...plan, allowedPaths: [] })).ok).toBe(false)
    expect((await drive(t, { ...plan, testCommands: [] })).ok).toBe(false)
    expect((await drive(t, { ...plan, planSummary: "短" })).ok).toBe(false)
  })
  test("end_dev 无变化拒绝且状态不变", async () => {
    const t = makeDeps()
    await drive(t, start)
    await drive(t, plan)
    await drive(t, { action: "begin_dev" })
    const r = await drive(t, { action: "end_dev", summary: DEV_REPORT })
    expect(r.ok).toBe(false)
    expect(t.store.task!.phase).toBe("dev_running")
  })
  test("begin_audit 无检查或检查过期拒绝", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    expect((await drive(t, { action: "begin_audit" })).ok).toBe(false)
    await drive(t, { action: "run_checks" })
    t.d.current = "drifted|dirty=2"
    expect((await drive(t, { action: "begin_audit" })).ok).toBe(false)
  })
  test("pass 附带 findings 拒绝", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    const r = await drive(t, {
      action: "end_audit",
      report: AUDIT_REPORT,
      verdict: "pass",
      findings: [{ id: "F1", category: "implementation", complexity: "low", reason: "r" }],
    })
    expect(r.ok).toBe(false)
  })
  test("测试未全绿时审计不能 pass", async () => {
    const t = makeDeps({ checksFail: true })
    await toAuditReady(t)
    await toAuditRunning(t)
    const r = await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    expect(r.ok).toBe(false)
    expect(t.store.task!.phase).toBe("audit_running")
  })
})

describe("findings 与预算", () => {
  test("findings 校验", () => {
    expect(validateFindings([]).error).toBeTruthy()
    expect(validateFindings([{ id: "F1", category: "implementation", complexity: "high" }]).error).toBeTruthy()
    expect(
      validateFindings([{ id: "F1", category: "implementation", complexity: "high", reason: "r" }]).findings,
    ).toHaveLength(1)
    expect(
      validateFindings([
        { id: "F1", category: "implementation", complexity: "high", reason: "r" },
        { id: "F1", category: "implementation", complexity: "low", reason: "r" },
      ]).error,
    ).toBeTruthy()
    expect(validateFindings([{ id: "F1", category: "wrong", complexity: "low", reason: "r" }]).error).toBeTruthy()
  })
  test("plan_gap/human_decision 直接 blocked_human", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    const r = await drive(t, {
      action: "end_audit",
      report: AUDIT_REPORT,
      verdict: "fail",
      findings: [{ id: "F1", category: "plan_gap", complexity: "high", reason: "缺少需求边界" }],
    })
    expect(r.ok).toBe(true)
    expect(t.store.task!.phase).toBe("blocked_human")
    expect((await drive(t, { action: "begin_fix" })).ok).toBe(false)
  })
  test("审计发现红检查→implementation 修复路径", async () => {
    const t = makeDeps({ checksFail: true })
    await toAuditReady(t)
    await toAuditRunning(t)
    const r = await drive(t, {
      action: "end_audit",
      report: AUDIT_REPORT,
      verdict: "fail",
      findings: [{ id: "F1", category: "implementation", complexity: "low", reason: "测试失败" }],
    })
    expect(r.ok).toBe(true)
    expect(t.store.task!.phase).toBe("fix_ready")
  })
  test("修复→复审→再失败→预算耗尽（maxRepairs=1）", async () => {
    const t = makeDeps()
    await drive(t, { ...start, maxRepairs: 1 })
    await drive(t, plan)
    await drive(t, { action: "begin_dev" })
    t.d.current = "dev1|dirty=1"
    await drive(t, { action: "end_dev", summary: DEV_REPORT })
    await toAuditRunning(t)
    const fail1 = await drive(t, {
      action: "end_audit",
      report: AUDIT_REPORT,
      verdict: "fail",
      findings: [{ id: "F1", category: "implementation", complexity: "low", reason: "边界错误" }],
    })
    expect(fail1.ok).toBe(true)
    expect(t.store.task!.phase).toBe("fix_ready")
    expect((await drive(t, { action: "begin_fix" })).ok).toBe(true)
    t.d.current = "fix1|dirty=1"
    expect((await drive(t, { action: "end_fix", summary: DEV_REPORT })).ok).toBe(true)
    expect(t.store.task!.repairsUsed).toBe(1)
    await toAuditRunning(t)
    const fail2 = await drive(t, {
      action: "end_audit",
      report: AUDIT_REPORT,
      verdict: "fail",
      findings: [{ id: "F2", category: "implementation", complexity: "low", reason: "仍错" }],
    })
    expect(fail2.ok).toBe(true)
    expect(t.store.task!.phase).toBe("exhausted")
    expect((await drive(t, { action: "begin_fix" })).ok).toBe(false)
    expect(launchAllowed(t.store, "add-feat", "add-feat-fixer").allowed).toBe(false)
  })
})

describe("篡改检测", () => {
  test("审计期间变化→tampered", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    t.d.current = "MUTATED|dirty=9"
    const r = await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    expect(r.ok).toBe(false)
    expect(t.store.task!.phase).toBe("tampered")
  })
  test("审计通过后变化→final_accept 拒绝并 tampered", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    t.d.current = "CHANGED|dirty=2"
    const r = await drive(t, accept)
    expect(r.ok).toBe(false)
    expect(t.store.task!.phase).toBe("tampered")
  })
  test("final_accept 复检失败→fix_ready 并生成 AF-1", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    t.d.failChecks = true
    const r = await drive(t, accept)
    expect(r.ok).toBe(true)
    expect(t.store.task!.phase).toBe("fix_ready")
    expect(t.store.task!.findings[0]!.id).toBe("AF-1")
  })
  test("planning 期间外部变化→基线软重置而非 tampered（people-rec 事故回归）", async () => {
    const t = makeDeps()
    await drive(t, start)
    t.d.current = "OUTSIDE|dirty=3"
    const r = await drive(t, plan)
    expect(r.ok).toBe(true)
    expect(t.store.task!.phase).toBe("dev_ready")
    expect(t.store.task!.baselineDigest).toBe("OUTSIDE|dirty=3")
    expect(t.store.task!.baselineDirtyCount).toBe(3)
    expect(t.store.task!.digestScope).toBe("scoped")
    expect(t.store.task!.log.some((l) => l.action === "baseline_rebase")).toBe(true)
    // 基线重置后，后续阶段以新基线正常推进（范围内变化才参与判定）
    await drive(t, { action: "begin_dev" })
    t.d.current = "dev1|dirty=4"
    expect((await drive(t, { action: "end_dev", summary: DEV_REPORT })).ok).toBe(true)
  })
})

describe("launchAllowed", () => {
  test("非协调者一律拒绝工作流角色", async () => {
    const t = makeDeps()
    await drive(t, start)
    expect(launchAllowed(t.store, "build", "add-feat-developer").allowed).toBe(false)
    expect(launchAllowed(t.store, undefined, "add-feat-auditor").allowed).toBe(false)
  })
  test("阶段匹配才放行", async () => {
    const t = makeDeps()
    await drive(t, start)
    await drive(t, plan)
    expect(launchAllowed(t.store, "add-feat", "add-feat-developer").allowed).toBe(false)
    await drive(t, { action: "begin_dev" })
    expect(launchAllowed(t.store, "add-feat", "add-feat-developer").allowed).toBe(true)
    expect(launchAllowed(t.store, "add-feat", "add-feat-auditor").allowed).toBe(false)
    expect(launchAllowed(t.store, "add-feat", "add-feat-fixer").allowed).toBe(false)
  })
  test("无关 agent 不受影响", async () => {
    const t = makeDeps()
    await drive(t, start)
    expect(launchAllowed(t.store, "build", "general").allowed).toBe(true)
  })
  test("终态拒绝所有工作流角色", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    await drive(t, accept)
    for (const agent of ["add-feat-developer", "add-feat-auditor", "add-feat-fixer", "add-feat-fixer-flash"]) {
      expect(launchAllowed(t.store, "add-feat", agent).allowed).toBe(false)
    }
  })
})

describe("复审修复回归", () => {
  test("B1 契约：tampered 变更在 ok:false 时也已写入 store（调用方必须无条件落盘）", async () => {    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    t.d.current = "MUTATED|dirty=9"
    const r = await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    expect(r.ok).toBe(false)
    expect(t.store.task!.phase).toBe("tampered")
    expect(t.store.task!.closeReason).toContain("审计期间")
    // 卡死解除：终态后可新建任务
    const again = await drive(t, { ...start, requirement: "另一个合法需求" })
    expect(again.ok).toBe(true)
  })
  test("A6：final_accept 期间摘要漂移→tampered（即使测试全绿）", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    const original = t.runChecks
    t.runChecks = async (task) => {
      const r = await original(task)
      return { checks: r.checks, digest: "DRIFTED-DURING-CHECKS|dirty=1" }
    }
    const r = await drive(t, accept)
    expect(r.ok).toBe(false)
    expect(t.store.task!.phase).toBe("tampered")
  })
  test("A8：abort_task 可从任意非终态中止并记录历史", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    const r = await drive(t, { action: "abort_task", reason: "用户要求停止" })
    expect(r.ok).toBe(true)
    expect(t.store.task!.phase).toBe("cancelled")
    expect(t.store.history).toHaveLength(1)
    expect(t.store.history[0]!.phase).toBe("cancelled")
    expect((await drive(t, { ...start, requirement: "重新来过的需求" })).ok).toBe(true)
    // reason 太短拒绝
    const t2 = makeDeps()
    await drive(t2, start)
    expect((await drive(t2, { action: "abort_task", reason: "x" })).ok).toBe(false)
  })
  test("A9：accepted 也进入历史", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    await drive(t, accept)
    expect(t.store.history[0]!.phase).toBe("accepted")
  })
  test("extend_budget：从 exhausted 复活追加轮数（需用户原话）", async () => {
    const t = makeDeps()
    await drive(t, { ...start, maxRepairs: 1 })
    await drive(t, plan)
    await drive(t, { action: "begin_dev" })
    t.d.current = "dev1|dirty=1"
    await drive(t, { action: "end_dev", summary: DEV_REPORT })
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "fail", findings: [{ id: "F1", category: "implementation", complexity: "low", reason: "r" }], report: AUDIT_REPORT })
    await drive(t, { action: "begin_fix" })
    t.d.current = "fix1|dirty=1"
    await drive(t, { action: "end_fix", summary: DEV_REPORT })
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "fail", findings: [{ id: "F2", category: "implementation", complexity: "low", reason: "r" }], report: AUDIT_REPORT })
    expect(t.store.task!.phase).toBe("exhausted")
    // 非法：无原话 / 越界
    expect((await drive(t, { action: "extend_budget", additionalRounds: 2 })).ok).toBe(false)
    expect((await drive(t, { action: "extend_budget", additionalRounds: 2, userQuote: "加轮" })).ok).toBe(false)
    expect((await drive(t, { action: "extend_budget", additionalRounds: 9, userQuote: "再加九轮行吗" })).ok).toBe(false)
    // 合法：复活
    const r = await drive(t, { action: "extend_budget", additionalRounds: 3, userQuote: "不够用，再加3轮继续修" })
    expect(r.ok).toBe(true)
    expect(t.store.task!.phase).toBe("fix_ready")
    expect(t.store.task!.maxRepairs).toBe(4)
    expect((await drive(t, { action: "begin_fix" })).ok).toBe(true)
  })
  test("extend_budget：活动阶段追加不改期；终态 accepted/tampered 拒绝", async () => {
    const t = makeDeps()
    await drive(t, { ...start, maxRepairs: 4 })
    await drive(t, plan)
    const r = await drive(t, { action: "extend_budget", additionalRounds: 2, userQuote: "这活复杂，先加两轮预算" })
    expect(r.ok).toBe(true)
    expect(t.store.task!.maxRepairs).toBe(6)
    expect(t.store.task!.phase).toBe("dev_ready")
    // 总上限 16
    for (let i = 0; i < 3; i++) {
      await drive(t, { action: "extend_budget", additionalRounds: 4, userQuote: "继续追加四轮" })
    }
    expect((await drive(t, { action: "extend_budget", additionalRounds: 4, userQuote: "还想加四轮" })).ok).toBe(false)
    // accepted 终态拒绝
    const t2 = makeDeps()
    await toAuditReady(t2)
    await toAuditRunning(t2)
    await drive(t2, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    await drive(t2, accept)
    expect((await drive(t2, { action: "extend_budget", additionalRounds: 1, userQuote: "再补一轮" })).ok).toBe(false)
  })
  test("会话绑定：跨会话仅 status/abort 可用", async () => {
    const t = makeDeps()
    const s1 = await drive(t, { ...start, sessionId: "ses_AAA" })
    expect(s1.ok).toBe(true)
    expect(t.store.task!.ownerSession).toBe("ses_AAA")
    // 同会话正常
    expect((await drive(t, { ...plan, sessionId: "ses_AAA" })).ok).toBe(true)
    // 跨会话状态变更被拒
    const r = await drive(t, { action: "begin_dev", sessionId: "ses_BBB" })
    expect(r.ok).toBe(false)
    expect(String((r as { error?: string }).error)).toContain("其他会话")
    // 跨会话只读 status 允许
    expect((await drive(t, { action: "status", sessionId: "ses_BBB" })).ok).toBe(true)
    // 跨会话恢复阀 abort 允许
    expect((await drive(t, { action: "abort_task", sessionId: "ses_BBB", reason: "原会话已关闭" })).ok).toBe(true)
    // 终态后可重开，新任务绑定新会话
    expect((await drive(t, { ...start, sessionId: "ses_BBB", requirement: "重新来过的合法需求" })).ok).toBe(true)
    expect(t.store.task!.ownerSession).toBe("ses_BBB")
  })
})

describe("过程文档落地（v2）", () => {
  test("accepted 可授权补写已登记 delivery，先备份；不复检、不改结论和轮次", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    await drive(t, accept)
    const task = t.store.task!
    const target = renderDocPaths(task.docRules, { task: task.taskSlug, round: 1, dirDate: task.startDate, fileDate: task.roundStartDate! }).delivery!
    task.processOutputs[target] = "oldhash"
    const history = JSON.stringify(t.store.history)
    const closedAt = task.closedAt
    const checks = JSON.stringify(task.checks)
    t.runChecks = async () => { throw new Error("文档补写不能复检") }
    const r = await drive(t, { action: "revise_delivery", deliveryPath: target, userQuote: "确认将完整交付正文写入原文件", reason: "按新规范补全工程交接内容", report: "## 完整新版正文\n接口、存储与验证边界。" })
    expect(r.ok).toBe(true)
    expect(task.phase).toBe("accepted")
    expect(task.closedAt).toBe(closedAt)
    expect(JSON.stringify(t.store.history)).toBe(history)
    expect(JSON.stringify(task.checks)).toBe(checks)
    expect(task.repairsUsed).toBe(0)
    expect(t.d.archives).toEqual([{ path: target, hash: "oldhash" }])
    expect(t.d.docs.at(-1)!.kind).toBe("delivery")
    expect(t.d.docs.at(-1)!.content).toContain("完整新版正文")
    expect(t.d.docs.at(-1)!.content).toContain("原验收证据（非本次重跑）")
    expect(task.log.at(-1)!.detail).toContain("oldhash")
  })
  test("补写拒绝：授权/正文/路径缺失、未登记、代码或过程文件变化、跨会话", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    await drive(t, accept)
    const task = t.store.task!
    const target = renderDocPaths(task.docRules, { task: task.taskSlug, round: 1, dirDate: task.startDate, fileDate: task.roundStartDate! }).delivery!
    task.processOutputs[target] = "oldhash"
    const input = { action: "revise_delivery", deliveryPath: target, userQuote: "确认补写交付文档", reason: "按新规范完善", report: "完整交付正文" }
    for (const patch of [{ userQuote: "" }, { reason: "" }, { report: " " }, { deliveryPath: "" }, { deliveryPath: "other.md" }]) {
      expect((await drive(t, { ...input, ...patch })).ok).toBe(false)
    }
    delete task.processOutputs[target]
    expect((await drive(t, input)).ok).toBe(false)
    task.processOutputs[target] = "oldhash"
    t.d.current = "changed"
    expect((await drive(t, input)).ok).toBe(false)
    t.d.current = task.auditedDigest!
    t.d.intact = false
    expect((await drive(t, input)).ok).toBe(false)
    t.d.intact = true
    task.ownerSession = "ses_owner"
    expect((await drive(t, { ...input, sessionId: "ses_other" })).ok).toBe(false)
    expect(t.d.archives).toHaveLength(0)
    expect(task.phase).toBe("accepted")
    task.ownerSession = undefined
    const archiveDelivery = t.archiveDelivery
    const count = t.d.docs.length
    t.archiveDelivery = async () => { throw new Error("无法备份") }
    expect((await drive(t, input)).ok).toBe(false)
    expect(t.d.docs).toHaveLength(count)
    t.archiveDelivery = archiveDelivery
    t.d.docError = "磁盘满"
    expect((await drive(t, input)).ok).toBe(false)
    expect(task.phase).toBe("accepted")
    expect(task.log.some((x) => x.action === "revise_delivery")).toBe(false)
  })
  test("补写仅 accepted 可用", async () => {
    const t = makeDeps()
    await drive(t, start)
    const input = { action: "revise_delivery", userQuote: "确认补写交付文档", reason: "按新规范完善", report: "正文", deliveryPath: "delivery.md" }
    for (const phase of ["planning", "accept_ready", "exhausted", "blocked_human", "tampered", "cancelled"] as const) {
      t.store.task!.phase = phase
      expect((await drive(t, input)).ok).toBe(false)
    }
    expect(t.d.archives).toHaveLength(0)
  })
  test("confirm_plan 触发 plan+readme+index；dev/audit 按轮写；accepted 写 delivery 草稿", async () => {
    const t = makeDeps()
    await drive(t, { ...start, taskSlug: "用户资料" })
    await drive(t, { ...plan, planDocument: "# 完整计划\n..." })
    const kinds = t.d.docs.map((x) => x.kind)
    expect(kinds).toContain("plan")
    expect(kinds).toContain("readme")
    expect(kinds).toContain("index")
    expect(t.store.task!.taskSlug).toBe("用户资料")
    expect(t.store.task!.docRules.dir).toContain("{task}")
    await drive(t, { action: "begin_dev" })
    t.d.current = "dev1|dirty=1"
    await drive(t, { action: "end_dev", summary: DEV_REPORT })
    expect(t.d.docs.at(-1)!.kind).toBe("dev")
    expect(t.d.docs.at(-1)!.round).toBe(1)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: "审计报告" })
    expect(t.d.docs.some((x) => x.kind === "audit" && x.round === 1)).toBe(true)
    await drive(t, accept)
    expect(t.d.docs.some((x) => x.kind === "delivery")).toBe(true)
    const content = t.d.docs.find((x) => x.kind === "delivery")!.content
    expect(content).toContain(accept.report)
    expect(content).toContain("AI 验收通过，未经人工确认")
    expect(content).toContain("插件附录：最终可信复检")
    expect(content).toContain("dev1|dirty=1")
    expect(content).toContain("pytest -q` → 退出码 0")
    expect(content).not.toContain("- 需求：")
  })
  test("配置 delivery 时缺失或空白正文拒绝，不运行复检也不落盘；补正文可重试", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    const originalChecks = t.runChecks
    let calls = 0
    t.runChecks = async (task) => { calls++; return originalChecks(task) }
    for (const report of [undefined, "", " \n "]) {
      const result = await drive(t, { action: "final_accept", report })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("完整交付正文")
      expect(t.store.task!.phase).toBe("accept_ready")
    }
    expect(calls).toBe(0)
    expect(t.d.docs.some((x) => x.kind === "delivery")).toBe(false)
    expect((await drive(t, accept)).ok).toBe(true)
    expect(calls).toBe(1)
  })
  test("未配置 delivery 可不传正文，写入故障不提前 accepted 且可重试", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    t.d.docError = "磁盘满"
    expect((await drive(t, accept)).ok).toBe(false)
    expect(t.store.task!.phase).toBe("accept_ready")
    t.d.docError = null
    expect((await drive(t, accept)).ok).toBe(true)

    const t2 = makeDeps()
    await drive(t2, start)
    await drive(t2, { ...plan, docRules: { dir: "docs/{task}", plan: "p.md", dev: "d{round}.md", audit: "a{round}.md", delivery: null } })
    await drive(t2, { action: "begin_dev" })
    t2.d.current = "dev1|dirty=1"
    await drive(t2, { action: "end_dev", summary: DEV_REPORT })
    await toAuditRunning(t2)
    await drive(t2, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    expect((await drive(t2, { action: "final_accept" })).ok).toBe(true)
    expect(t2.d.docs.some((x) => x.kind === "delivery")).toBe(false)
  })
  test("自定义项目规则：docRules 冻结并用于后续轮次", async () => {
    const t = makeDeps()
    await drive(t, { ...start, taskSlug: "用户资料" })
    const custom = {
      dir: "过程记录/{task}_{date}",
      plan: "计划.v1.r1.{date}.md",
      dev: "开发.r{round}.{date}.md",
      audit: "审计.r{round}.{date}.md",
      delivery: null,
      taskReadme: null,
      index: "过程记录/索引.md",
      note: "项目 AGENTS.md",
    }
    const r = await drive(t, { ...plan, docRules: custom })
    expect(r.ok).toBe(true)
    expect(t.store.task!.docRules).toEqual(custom)
  })
  test("非法 docRules / taskSlug 拒绝", async () => {
    const t = makeDeps()
    expect((await drive(t, { ...start, taskSlug: "bad slug" })).ok).toBe(false)
    expect((await drive(t, { ...start, taskSlug: "a.b" })).ok).toBe(false)
    await drive(t, { ...start, taskSlug: "ok" })
    expect((await drive(t, { ...plan, docRules: { dir: "../逃逸", plan: "p.md", dev: "d.md", audit: "a.md" } })).ok).toBe(false)
    expect((await drive(t, { ...plan, docRules: { dir: "d", plan: "/abs", dev: "d.md", audit: "a.md" } })).ok).toBe(false)
    expect((await drive(t, { ...plan, docRules: { dir: "d", plan: "p.md", dev: "d.md" } })).ok).toBe(false)
  })
  test("过程文档被改→边界判 tampered；写入失败→报错且阶段不变", async () => {
    const t = makeDeps()
    await drive(t, { ...start, taskSlug: "t" })
    await drive(t, plan)
    await drive(t, { action: "begin_dev" })
    t.d.current = "dev1|dirty=1"
    // 写入失败
    t.d.docError = "磁盘满"
    const r = await drive(t, { action: "end_dev", summary: DEV_REPORT })
    expect(r.ok).toBe(false)
    expect(t.store.task!.phase).toBe("dev_running")
    t.d.docError = null
    const ok2 = await drive(t, { action: "end_dev", summary: DEV_REPORT })
    expect(ok2.ok).toBe(true)
    // 过程文档完整性破坏 → 审计边界 tampered
    t.d.intact = false
    await drive(t, { action: "run_checks" })
    const audit = await drive(t, { action: "begin_audit" })
    expect(audit.ok).toBe(true)
    const end = await drive(t, { action: "end_audit", verdict: "pass", report: AUDIT_REPORT })
    expect(end.ok).toBe(false)
    expect(t.store.task!.phase).toBe("tampered")
  })
})

describe("过程文档质量强制（规范置入）", () => {
  test("end_audit 无正文拒绝（pass 与 fail 都要求 report），补正文后放行", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    const r1 = await drive(t, { action: "end_audit", verdict: "pass" })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toContain("完整报告正文")
    const r2 = await drive(t, { action: "end_audit", verdict: "fail", findings: [{ id: "F1", category: "implementation", complexity: "low", reason: "r" }] })
    expect(r2.ok).toBe(false)
    expect(t.store.task!.phase).toBe("audit_running")
    const r3 = await drive(t, { action: "end_audit", verdict: "fail", findings: [{ id: "F1", category: "implementation", complexity: "low", reason: "r" }], report: AUDIT_REPORT })
    expect(r3.ok).toBe(true)
    expect(t.store.task!.phase).toBe("fix_ready")
  })
  test("end_dev 报告过短拒绝且阶段不变，补全后放行", async () => {
    const t = makeDeps()
    await drive(t, start)
    await drive(t, plan)
    await drive(t, { action: "begin_dev" })
    t.d.current = "dev1|dirty=1"
    const r1 = await drive(t, { action: "end_dev", summary: "改好了" })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toContain("过于单薄")
    expect(t.store.task!.phase).toBe("dev_running")
    expect(t.d.docs.some((x) => x.kind === "dev")).toBe(false)
    const r2 = await drive(t, { action: "end_dev", summary: DEV_REPORT })
    expect(r2.ok).toBe(true)
  })
  test("end_fix 报告过短拒绝", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "fail", findings: [{ id: "F1", category: "implementation", complexity: "low", reason: "r" }], report: AUDIT_REPORT })
    await drive(t, { action: "begin_fix" })
    t.d.current = "fix1|dirty=2"
    const r = await drive(t, { action: "end_fix", summary: "修复F1完成" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("过于单薄")
    expect(t.store.task!.phase).toBe("fix_running")
  })
  test("README 是导航页：计划链接/轮次报告表/未关闭问题清单", async () => {
    const t = makeDeps()
    await toAuditReady(t)
    await toAuditRunning(t)
    await drive(t, {
      action: "end_audit",
      verdict: "fail",
      findings: [{ id: "F1", category: "implementation", complexity: "high", reason: "并发窗口导致旧数据发布" }],
      report: AUDIT_REPORT,
    })
    const readme = t.d.docs.filter((x) => x.kind === "readme").at(-1)!.content
    expect(readme).toContain("有效计划")
    expect(readme).toContain("plan.v1.r1")
    expect(readme).toContain("轮次报告")
    expect(readme).toContain("[audit](")
    expect(readme).toContain("未关闭问题")
    expect(readme).toContain("**F1**")
    expect(readme).toContain("并发窗口")
    expect(readme).toContain("改动未提交")
  })
})

describe("append_audit：终态后复核登记", () => {
  async function toExhausted() {
    const t = makeDeps()
    await drive(t, { ...start, maxRepairs: 1 })
    await drive(t, plan)
    await drive(t, { action: "begin_dev" })
    t.d.current = "dev1|dirty=1"
    await drive(t, { action: "end_dev", summary: DEV_REPORT })
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "fail", findings: [{ id: "F1", category: "implementation", complexity: "low", reason: "r" }], report: AUDIT_REPORT })
    await drive(t, { action: "begin_fix" })
    t.d.current = "fix1|dirty=2"
    await drive(t, { action: "end_fix", summary: DEV_REPORT })
    await toAuditRunning(t)
    await drive(t, { action: "end_audit", verdict: "fail", findings: [{ id: "F2", category: "implementation", complexity: "low", reason: "r" }], report: AUDIT_REPORT })
    expect(t.store.task!.phase).toBe("exhausted")
    return t
  }
  test("exhausted 后登记：编号取下一空位，终态/关闭时间/历史不变，README 刷新", async () => {
    const t = await toExhausted()
    const task = t.store.task!
    const closedAt = task.closedAt
    const history = JSON.stringify(t.store.history)
    const auditRounds = Object.keys(task.processOutputs).filter((k) => k.includes("audit")).length
    const r = await drive(t, { action: "append_audit", report: AUDIT_REPORT, reason: "终态后整体技术复核，非独立审计" })
    expect(r.ok).toBe(true)
    expect(task.phase).toBe("exhausted")
    expect(task.closedAt).toBe(closedAt)
    expect(JSON.stringify(t.store.history)).toBe(history)
    // 上一轮 audit 登记到 r3（repairsUsed+1=2 起），下一个空位 = r4
    const lastAudit = t.d.docs.filter((x) => x.kind === "audit").at(-1)!
    expect(lastAudit.round).toBe(auditRounds + 1)
    expect(lastAudit.content).toBe(AUDIT_REPORT)
    const readme = t.d.docs.filter((x) => x.kind === "readme").at(-1)!.content
    expect(readme).toContain("终态 exhausted")
    expect(readme).toContain("非独立审计")
    expect(task.log.at(-1)!.action).toBe("append_audit")
  })
  test("拒绝：非 accepted/exhausted、缺正文、缺 reason、过程文档不完整", async () => {
    const t = await toExhausted()
    const base = { action: "append_audit", report: AUDIT_REPORT, reason: "终态后复核记录" }
    t.store.task!.phase = "fix_ready"
    expect((await drive(t, base)).ok).toBe(false)
    t.store.task!.phase = "exhausted"
    expect((await drive(t, { ...base, report: "" })).ok).toBe(false)
    expect((await drive(t, { ...base, reason: "x" })).ok).toBe(false)
    t.d.intact = false
    expect((await drive(t, base)).ok).toBe(false)
    t.d.intact = true
    const ok2 = await drive(t, base)
    expect(ok2.ok).toBe(true)
  })
})
