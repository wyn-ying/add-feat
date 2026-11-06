/** add-feat：subagent 开发工作流插件。
 *
 * 编排（澄清/派发/验收叙述）由 add-feat agent 完成；本插件只做四件事：
 *  1) addfeat_gate 工具：任务状态机 + 服务端独立测试 + git 摘要 + 过程文档写入。
 *  2) 权限钩子：subagent 启动按状态机硬放行/拒绝；闸门工具仅协调者可用。
 *  3) subagent 启动日志。
 *  4) 过程文档（plan/dev/audit/delivery 等）按"随计划冻结的项目规则"服务端写入，
 *     路径登记进任务状态：摘要精确排除 + 内容哈希复核（排除区不是盲区）。
 */
import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import {
  DEFAULT_REPAIRS,
  TERMINAL,
  type CheckResult,
  type GateInput,
  type GateResult,
  type Store,
  type Task,
  clampRepairs,
  digestExclusionsFor,
  launchAllowed,
  transition,
} from "./workflow"
import { runChecks } from "./checkrunner"
import { workspaceDigest, workspaceDiff, verifyProcessOutputs, pathInScope } from "./wsdiff"
import { loadStore, saveStore, statePath } from "./storefile"
import { renderDocPaths, safeDocPath } from "./docpaths"
import { archiveDelivery } from "./deliveryarchive"
import { mergeBack, prepareIsolation, readIsolationMeta } from "./isolate"
import { coordinatorEditAllowed } from "./coordinator-edit"

const STATE_ROOT = join(homedir(), ".local/state/add-feat")
const WORKFLOW_AGENTS = new Set([
  "add-feat-developer",
  "add-feat-auditor",
  "add-feat-fixer",
  "add-feat-fixer-flash",
])
const GATE_TOOL = "addfeat_gate"
const COORDINATOR = "add-feat"

interface PluginConfig {
  maxRepairs?: number
  testTimeoutSeconds?: number
}

async function readConfig(): Promise<PluginConfig> {
  try {
    return JSON.parse(await readFile(join(homedir(), ".config/opencode/add-feat.json"), "utf8"))
  } catch {
    return {}
  }
}

function stateKey(locationDir: string): string {
  return createHash("sha256").update(locationDir).digest("hex").slice(0, 16)
}

function journalPath(locationDir: string): string {
  return join(STATE_ROOT, `journal-${stateKey(locationDir)}.jsonl`)
}

async function appendJournal(locationDir: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const path = journalPath(locationDir)
    await mkdir(dirname(path), { recursive: true })
    let prior = ""
    try {
      prior = await readFile(path, "utf8")
    } catch {
      /* 首条 */
    }
    const lines = prior.split("\n").filter(Boolean)
    lines.push(JSON.stringify(entry))
    while (lines.length > 500) lines.shift()
    await writeFile(path, lines.join("\n") + "\n", { mode: 0o600 })
  } catch {
    /* 日志失败不阻断主流程 */
  }
}

function brief(task: Task | null) {
  if (!task) return null
  return {
    id: task.id,
    phase: task.phase,
    taskSlug: task.taskSlug,
    startDate: task.startDate,
    ownerSession: task.ownerSession ?? null,
    maxRepairs: task.maxRepairs,
    repairsUsed: task.repairsUsed,
    requirement: task.requirement,
    plan: task.plan ?? null,
    docRules: task.docRules,
    processOutputs: Object.keys(task.processOutputs),
    findings: task.findings,
    checks: task.checks.map((c: CheckResult) => ({
      command: c.command,
      exitCode: c.exitCode,
      timedOut: c.timedOut,
      durationMs: c.durationMs,
      // 失败命令附带输出尾部，协调者/修复者才能定位原因（成功命令保持精简）。
      ...(c.exitCode !== 0 ? { stdoutTail: c.stdoutTail.slice(-800), stderrTail: c.stderrTail.slice(-800) } : {}),
    })),
    log: task.log,
    closedAt: task.closedAt ?? null,
    closeReason: task.closeReason ?? null,
  }
}

export default Plugin.define({
  id: "add-feat",
  async setup(ctx) {
    const locationDir = ctx.location.directory

    await ctx.tool.transform((editor) => {
      editor.add({
        name: GATE_TOOL,
        options: { codemode: false },
        description:
          "add-feat 工作流闸门：任务状态机、服务端独立测试、阶段 git 摘要与可信 diff、按项目规则落地过程文档。另支持 extend_budget 人工追加轮数、revise_delivery 在 accepted 后授权补写既有交付正文（不重跑验收）、append_audit 在 exhausted/accepted 后登记终态后复核记录（不改变终态）、diff_meta 在大差异被工具输出截断时单独返回 status/stat/未跟踪清单、prepare_worktree/merge_back 工作间隔离与合并（后者需人工授权）。非法转移会被拒绝并返回原因。",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "status",
                "start_task",
                "cancel_task",
                "abort_task",
                "confirm_plan",
                "begin_dev",
                "end_dev",
                "run_checks",
                "begin_audit",
                "end_audit",
                "begin_fix",
                "end_fix",
                "final_accept",
                "extend_budget",
                "revise_delivery",
                "append_audit",
                "prepare_worktree",
                "merge_back",
                "diff",
                "diff_meta",
              ],
            },
            part: { type: "integer", minimum: 1, description: "diff 动作可选：返回第 N 片差异正文（每片≤20KB）" },
            additionalRounds: { type: "integer", minimum: 1, maximum: 8, description: "extend_budget 专用：追加修复轮数" },
            userQuote: { type: "string", description: "extend_budget/revise_delivery：用户追加轮数或授权补写的原话（人工授权留痕）" },
            deliveryPath: { type: "string", description: "revise_delivery 必填：本任务已登记的 delivery 精确仓库相对路径，不能另选文件" },
            requirement: { type: "string" },
            maxRepairs: { type: "integer", minimum: 1, maximum: 8 },
            taskSlug: { type: "string" },
            planSummary: { type: "string" },
            allowedPaths: { type: "array", items: { type: "string" } },
            testCommands: { type: "array", items: { type: "string" } },
            planDocument: { type: "string" },
            docRules: {
              type: "object",
              properties: {
                dir: { type: "string" },
                plan: { type: "string" },
                dev: { type: "string" },
                audit: { type: "string" },
                delivery: { type: ["string", "null"] },
                taskReadme: { type: ["string", "null"] },
                index: { type: ["string", "null"] },
                note: { type: "string" },
              },
              required: ["dir", "plan", "dev", "audit"],
            },
            summary: { type: "string" },
            report: { type: "string", description: "end_audit：审计者完整报告；final_accept/revise_delivery：按 delivery 撰写规范综合全部适用轮次的完整交付正文，不是需求摘要" },
            verdict: { type: "string", enum: ["pass", "fail"] },
            findings: { type: "array", items: { type: "object" } },
            reason: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const config = await readConfig()
          const input = raw as GateInput
          // 会话绑定：sessionID 来自工具执行上下文（服务端注入，模型不可伪造）。
          input.sessionId = context?.sessionID
          if (input.action === "diff" || input.action === "diff_meta") {
            const digest = await workspaceDigest(locationDir)
            if (!digest) return { content: JSON.stringify({ ok: false, error: "git 摘要不可用" }) }
            const d = await workspaceDiff(locationDir)
            const PART_BYTES = 20 * 1024
            // diff_meta：大差异被工具输出上限整体转存时的轻量入口——单独返回
            // status/stat/untracked（含各自截断标记）与分片总数，不携带 diff 正文。
            if (input.action === "diff_meta") {
              return {
                content: JSON.stringify({
                  ok: true,
                  digest,
                  status: d.status,
                  stat: d.stat,
                  untracked: d.untracked,
                  statusTruncated: d.statusTruncated,
                  statTruncated: d.statTruncated,
                  untrackedTruncated: d.untrackedTruncated,
                  diffHardTruncated: d.diffHardTruncated,
                  diffTotalParts: Math.max(1, Math.ceil(d.diffFull.length / PART_BYTES)),
                  partBytes: PART_BYTES,
                }),
              }
            }
            // part 分片：只读审计者读不到项目外工具输出指针，协调者按片转述（每片≤20KB）。
            const part = typeof (raw as { part?: unknown }).part === "number" ? (raw as { part: number }).part : undefined
            if (part !== undefined && part >= 1) {
              const total = Math.max(1, Math.ceil(d.diffFull.length / PART_BYTES))
              return {
                content: JSON.stringify({
                  ok: true,
                  digest,
                  part,
                  totalParts: total,
                  hardTruncated: d.diffHardTruncated,
                  diffPart: d.diffFull.slice((part - 1) * PART_BYTES, part * PART_BYTES),
                }),
              }
            }
            return { content: JSON.stringify({ ok: true, digest, ...d, diffFull: undefined }) }
          }
          // 工作间隔离：澄清/计划呈现场景中由协调者征询用户后调用；不占用任务槽。
          // 成功即迁移会话；后续 start_task/confirm_plan 落在工作间的独立状态文件。
          // 主树有活动任务时同样允许——这正是并行场景（主树任务不受影响：隔离摘要按范围/目录区分）。
          if (input.action === "prepare_worktree") {
            const slug = typeof input.taskSlug === "string" && input.taskSlug.trim() ? input.taskSlug.trim() : "task"
            try {
              const r = await prepareIsolation({ sourceDir: locationDir, slug })
              try {
                await ctx.session.move({ sessionID: context.sessionID, directory: r.worktreePath })
              } catch (moveError) {
                await appendJournal(locationDir, {
                  at: new Date().toISOString(),
                  kind: "gate",
                  action: "prepare_worktree",
                  ok: false,
                  reason: `会话迁移失败：${String(moveError).slice(0, 160)}`,
                })
                return {
                  content: JSON.stringify({
                    ok: false,
                    error:
                      `工作间已创建并保留：${r.worktreePath}（分支 ${r.branch}），但会话迁移失败：${String(moveError).slice(0, 160)}。` +
                      "降级方案：告知用户在该目录新开窗口、重新 /add-feat（澄清结论需重述）；不要在主目录继续本任务，也不要删除工作间",
                  }),
                }
              }
              await appendJournal(locationDir, {
                at: new Date().toISOString(),
                kind: "gate",
                action: "prepare_worktree",
                ok: true,
                detail: `${r.worktreePath} branch=${r.branch} base=${r.baselineCommit.slice(0, 10)} untracked=${r.inheritedUntracked}`,
              })
              return {
                content: JSON.stringify({
                  ok: true,
                  message:
                    `工作间就绪：${r.worktreePath}（分支 ${r.branch}；基线快照 ${r.baselineCommit.slice(0, 10)}；` +
                    `继承未跟踪 ${r.inheritedUntracked} 个${r.skippedUntracked.length ? `，跳过 ${r.skippedUntracked.length} 个` : ""}）。会话已迁入。` +
                    '下一步立即调用 addfeat_gate {action:"status"} 验证迁移生效——预期返回"没有进行中任务"（这是工作间的独立状态文件，属正常现象）；' +
                    "随后照常 start_task + confirm_plan 推进。",
                  worktree: {
                    path: r.worktreePath,
                    branch: r.branch,
                    baselineCommit: r.baselineCommit,
                    skippedUntracked: r.skippedUntracked,
                  },
                }),
              }
            } catch (e) {
              return { content: JSON.stringify({ ok: false, error: `创建工作间失败：${String(e).slice(0, 300)}` }) }
            }
          }
          if (input.action === "start_task" && input.maxRepairs === undefined) {
            input.maxRepairs = clampRepairs(config.maxRepairs, DEFAULT_REPAIRS)
          }
          const loaded = await loadStore(STATE_ROOT, locationDir)
          if (!loaded.ok) {
            // 防清空守卫：状态文件不可用时只读报错，绝不以空 store 覆盖真实任务。
            await appendJournal(locationDir, {
              at: new Date().toISOString(),
              kind: "load-refused",
              action: input.action,
              reason: loaded.reason,
            })
            return { content: JSON.stringify({ ok: false, error: `任务状态文件不可用，已拒绝操作以防覆盖：${loaded.reason}。请人工检查 ${statePath(STATE_ROOT, locationDir)}` }) }
          }
          const store = loaded.store
          const testTimeout = Math.min(Math.max(config.testTimeoutSeconds ?? 120, 10), 900)

          const excludesOf = (task: Task | null) => Object.keys(task?.processOutputs ?? {})

          /** 一致性强制摘要：scoped 任务（confirm_plan 起冻结范围）只对 allowedPaths+HEAD
           *  计哈希；full（含遗留任务）沿用全域。返回 { enforced, full }——full 仅作漂移观察。 */
          const computeDigests = async (task: Task | null, excludes: string[]) => {
            const full = await workspaceDigest(locationDir, excludes)
            if (task?.plan && task.digestScope === "scoped") {
              const enforced = await workspaceDigest(locationDir, excludes, task.plan.allowedPaths)
              return { full, enforced }
            }
            return { full, enforced: full }
          }

          async function writeDocAtomic(rel: string, content: string): Promise<string> {
            if (!safeDocPath(rel)) throw new Error(`过程文档路径不安全：${rel}`)
            const abs = join(locationDir, rel)
            await mkdir(dirname(abs), { recursive: true })
            const tmp = `${abs}.tmp-${Date.now()}`
            await writeFile(tmp, content, "utf8")
            await rename(tmp, abs)
            return createHash("sha256").update(content, "utf8").digest("hex")
          }

          const deps = {
            archiveDelivery: (path: string, hash: string) => archiveDelivery(STATE_ROOT, locationDir, path, hash),
            now: () => new Date().toISOString(),
            newId: () => `af-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            localDate: () => {
              const d = new Date()
              const pad = (n: number) => String(n).padStart(2, "0")
              return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
            },
            digest: () => null as string | null,
            runChecks: async (task: Task) => {
              const { checks } = await runChecks(locationDir, task, testTimeout)
              const { enforced } = await computeDigests(task, Object.keys(task.processOutputs ?? {}))
              return { checks, digest: enforced }
            },
            emitDoc: async (
              kind: "plan" | "dev" | "audit" | "delivery" | "readme" | "index",
              round: number,
              content: string,
            ) => {
              const task = store.task
              if (!task) throw new Error("没有进行中任务")
              const paths = renderDocPaths(task.docRules, {
                task: task.taskSlug,
                round,
                dirDate: task.startDate,
                fileDate: task.roundStartDate ?? task.startDate,
              })
              const rel =
                kind === "plan" ? paths.plan
                : kind === "dev" ? paths.dev
                : kind === "audit" ? paths.audit
                : kind === "delivery" ? paths.delivery
                : kind === "readme" ? paths.readme
                : paths.index
              if (!rel) throw new Error(`项目规则未配置 ${kind} 文档`)
              if (kind === "index") {
                const abs = join(locationDir, rel)
                let existing = ""
                try {
                  existing = await readFile(abs, "utf8")
                } catch {
                  /* 新建 */
                }
                const marker = `${task.taskSlug}_`
                if (existing.includes(marker)) return // 已登记，幂等
                const merged = (existing ? existing.replace(/\s*$/, "\n") : "# Agent 协作开发任务索引\n") + content
                task.processOutputs[rel] = await writeDocAtomic(rel, merged)
                return
              }
              task.processOutputs[rel] = await writeDocAtomic(rel, content)
            },
            processOutputsIntact: (task: Task) => true,
          }

          // 摘要排除集按动作语义取：start_task 用新任务视角（空集），其余用当前任务登记项。
          // 一致性强制范围随计划冻结（scoped）；start_task 永远取全域作为新基线。
          const { full: digestFull, enforced: digestEnforced } = await computeDigests(
            input.action === "start_task" ? null : store.task,
            digestExclusionsFor(input.action, store.task),
          )
          deps.digest = () => digestEnforced
          const intactNow = await verifyProcessOutputs(locationDir, store.task?.processOutputs ?? {})
          deps.processOutputsIntact = () => intactNow

          let result: GateResult
          if (input.action === "merge_back") {
            // 终态任务的授权补写动作：不进状态机转移，直接执行合并流程。
            const runMergeBack = async (): Promise<GateResult> => {
              const task = store.task
              const quote = typeof input.userQuote === "string" ? input.userQuote.trim() : ""
              if (!task || task.phase !== "accepted") {
                return { ok: false, error: "merge_back 只能在 accepted 任务上执行；当前无任务或未验收" }
              }
              if (quote.length < 4) {
                return { ok: false, error: "合并需要用户明确授权：请用户原话确认（如“确认合并回主目录”），并将原话逐字放入 userQuote" }
              }
              const meta = await readIsolationMeta(locationDir)
              if (!meta) {
                return { ok: false, error: "本任务不是工作间隔离任务（未找到 .add-feat/isolation.json）；无需合并" }
              }
              const ownerMatches = !task.ownerSession || task.ownerSession === context.sessionID
              let mainTaskActive: false | { id: string; phase: string } = false
              const mainLoaded = await loadStore(STATE_ROOT, meta.mergeTarget)
              if (mainLoaded.ok && mainLoaded.store.task && !TERMINAL.includes(mainLoaded.store.task.phase)) {
                mainTaskActive = { id: mainLoaded.store.task.id, phase: mainLoaded.store.task.phase }
              }
              const r = await mergeBack({
                worktreeDir: locationDir,
                mainDir: meta.mergeTarget,
                branch: meta.branch,
                baselineCommit: meta.baselineCommit,
                ownerMatches,
                mainTaskActive,
                // 过程文档常被 .gitignore 忽略，git 的补丁/未跟踪清单都看不到，必须显式点名。
                includePaths: Object.keys(task.processOutputs ?? {}),
                sessionMove: async (d) => {
                  await ctx.session.move({ sessionID: context.sessionID, directory: d })
                },
              })
              task.log.push({
                at: new Date().toISOString(),
                action: "merge_back",
                detail: r.ok
                  ? `applied=${r.appliedFiles.length} new=${r.newFiles.length} included=${r.includedFiles.length} cleanup=${JSON.stringify(r.cleanup)}`
                  : `${r.kind}: ${r.message.slice(0, 120)}`,
              })
              if (task.log.length > 200) task.log.splice(0, task.log.length - 200)
              return r.ok
                ? {
                    ok: true,
                    phase: task.phase,
                    task,
                    message:
                      `合并完成：主树已应用 ${r.appliedFiles.length} 个已跟踪文件补丁、${r.newFiles.length} 个新文件` +
                      (r.includedFiles.length ? `，并按登记清单搬运 ${r.includedFiles.length} 个过程文档` : "") +
                      "（均保持未提交，由用户 review）。" +
                      (r.cleanup.worktreeRemoved ? "工作间与分支已自动清理；" : "工作间保留（见备注）；") +
                      (r.cleanup.sessionMovedBack ? "会话已迁回主目录。" : "会话仍标记在工作间侧：") +
                      (r.notes.length ? `备注：${r.notes.join("；")}。` : "") +
                      "请建议用户在主目录复跑验收命令复核合并结果。",
                  }
                : {
                    ok: false,
                    error:
                      `合并未执行（${r.kind}）：${r.message}` +
                      (r.conflicts.length
                        ? `；涉及文件：${r.conflicts.slice(0, 10).join("、")}${r.conflicts.length > 10 ? "…" : ""}`
                        : ""),
                  }
            }
            result = await runMergeBack()
          } else {
            try {
              result = await transition(store, input, deps)
            } catch (error) {
              result = { ok: false, error: `闸门内部错误：${String(error)}` }
            }
          }
          // 范围外漂移观察（非强制）：scoped 任务的全域摘要相对上次观察发生变化时，
          // 附加范围外变化清单到结果，供协调者转述；不改变一致性判定，不阻断流程。
          const taskAfter = store.task
          if (taskAfter?.plan && typeof taskAfter.lastFullDigest === "string" && taskAfter.lastFullDigest !== digestFull) {
            try {
              const d = await workspaceDiff(locationDir)
              const scope = taskAfter.plan.allowedPaths
              const outside = [
                ...new Set(
                  d.status
                    .split("\n")
                    .map((line) => line.slice(3).split("\0")[0].split(" -> ").pop()?.trim() ?? "")
                    .filter(Boolean)
                    .filter((p) => !pathInScope(p, scope)),
                ),
              ].slice(0, 15)
              const note = `\n⚠ 范围外工作区变化（仅观察，不影响本任务一致性判定）：${outside.join("、") || "（清单不可得，可能为暂存区或 HEAD 变化）"}`
              if (result.ok) result.message += note
              else result.error += note
            } catch {
              /* 观察失败不阻断 */
            }
          }
          if (taskAfter?.plan) taskAfter.lastFullDigest = digestFull
          // B1 契约：终态变更（含 ok:false 的 tampered/exhausted）必须落盘。
          await saveStore(STATE_ROOT, store, true)
          // tampered 类失败附带当前工作区状态，便于人工定位改动来源。
          if (!result.ok && /tampered|发生变化/.test(result.error)) {
            try {
              const d = await workspaceDiff(locationDir)
              const all = d.status.split("\n").filter(Boolean)
              const lines = all.slice(0, 25)
              result = {
                ok: false,
                error:
                  result.error +
                  `\n当前工作区相对 git HEAD 的状态（人工核对用）：\n${
                    lines.join("\n") || "(无脏文件)"
                  }${all.length > lines.length ? "\n…(仅显示前 25 条)" : ""}${
                    d.untracked.length ? `\n未跟踪文件示例：${d.untracked.slice(0, 10).join("、")}` : ""
                  }`,
              }
            } catch {
              /* 差异获取失败不掩盖原始错误 */
            }
          }
          await appendJournal(locationDir, {
            at: new Date().toISOString(),
            kind: "gate",
            action: input.action,
            ok: result.ok,
            phase: result.ok ? result.phase : undefined,
          })
          return {
            content: JSON.stringify(
              result.ok
                ? { ok: true, phase: result.phase, message: result.message, task: brief(result.task) }
                : { ok: false, error: result.error },
              null,
              2,
            ),
          }
        },
      })
    })

    // 硬闸门：工作流角色 subagent 只能在对应阶段、由协调者启动。
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.action === "edit" && event.agent === COORDINATOR) {
        const loaded = await loadStore(STATE_ROOT, locationDir)
        if (!loaded.ok || !coordinatorEditAllowed(loaded.store.task?.phase)) {
          event.effect = "deny"
          event.message = "add-feat 子代理执行中或状态不可用：协调者暂不能编辑；请等待阶段结束"
          return
        }
      }
      if (event.action === GATE_TOOL && event.agent !== COORDINATOR) {
        event.effect = "deny"
        event.message = "addfeat_gate 只能由 add-feat 协调者调用"
        return
      }
      if (event.action !== "subagent") return
      const target = event.resources?.find((r) => WORKFLOW_AGENTS.has(r))
      if (!target) return
      const loaded = await loadStore(STATE_ROOT, locationDir)
      if (!loaded.ok) {
        event.effect = "deny"
        event.message = "add-feat 状态文件不可用，已拒绝角色启动（防覆盖）"
        return
      }
      const store = loaded.store
      const decision = launchAllowed(store, event.agent, target)
      if (!decision.allowed) {
        event.effect = "deny"
        event.message = decision.reason ?? "add-feat 阶段不允许启动该角色"
        // 拒绝留证：记录完整事件字段（agent 可选，可能为空或语义随调用方变化），便于定位误拒。
        await appendJournal(locationDir, {
          at: new Date().toISOString(),
          kind: "launch-denied",
          agent: event.agent ?? null,
          sessionID: event.sessionID,
          target,
          resources: event.resources,
          reason: decision.reason,
        })
        return
      }
      await appendJournal(locationDir, {
        at: new Date().toISOString(),
        kind: "launch",
        agent: event.agent,
        target,
      })
    })

    // 证据：subagent 派发日志。
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent") return
      const input = event.input as { agent?: string } | undefined
      const target = input?.agent
      if (target && WORKFLOW_AGENTS.has(target)) {
        await appendJournal(locationDir, {
          at: new Date().toISOString(),
          kind: "subagent-dispatch",
          agent: target,
          prompt: JSON.stringify(input).slice(0, 400),
        })
      }
    })
  },
})
