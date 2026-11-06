/** add-feat 工作间隔离：prepare_worktree / merge_back 的核心逻辑（纯新增，未接线）。
 *
 * 设计（用户已拍板，2026-11-03）：
 *  - 计划冻结前由协调者询问是否隔离；隔离 = 建 git worktree + 继承主树未提交状态
 *    + 工作间内私有基线快照 commit（用户授权的显式例外：仅存在于工作间分支，主目录零 commit）
 *    + 会话迁入工作间（index 接线层调 ctx.session.move）。start_task/confirm_plan 随会话
 *    落在工作间 → 状态文件按目录哈希天然隔离，主树任务不受影响。
 *  - merge_back：accepted 后人工授权（userQuote 留痕，接线层校验），导出 diff(基线) --binary
 *    补丁 + 新增未跟踪文件，应用到主树（先 --check 原子预检）；新文件逐一预检，任一冲突
 *    整体放弃。被 .gitignore 忽略的过程文档按任务登记清单（includePaths）显式搬运，
 *    不依赖 git 的跟踪/忽略判定，避免合并后随工作间删除而丢失。
 *    干净落地 → 会话迁回主树 → 自动删工作间与分支；冲突/失败 → 全部保留并给补丁路径。
 *  - 元数据在工作间 .add-feat/isolation.json，从补丁与新文件导出中排除。
 *
 * 纪律：本模块不 import 任何被热重载监视的既有文件（wsdiff/workflow/index），
 * 缓存排除清单在此复制维护，接线时与 wsdiff 合并；运行中任务不受本文件增改影响。
 */
import { execFile } from "node:child_process"
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export type RunGit = (cwd: string, args: string[]) => Promise<string>

export const runGitDefault: RunGit = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]}: ${String(stderr).slice(0, 300)}`))
      else resolve(String(stdout))
    })
  })

// —— 与 wsdiff.ts 保持一致（接线时合并为单一来源）——
const MAX_UNTRACKED = 500
const MAX_FILE_BYTES = 10 * 1024 * 1024
const CACHE_EXCLUDES = [
  "__pycache__/", "*.pyc", "*.pyo", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/",
  ".coverage", "htmlcov/", "*.egg-info/", ".tox/",
]
function cacheExcludeArgs(): string[] {
  return CACHE_EXCLUDES.flatMap((pattern) => ["--exclude", pattern])
}
function isCachePath(path: string): boolean {
  const parts = path.split("/")
  for (const part of parts) {
    if (part === "__pycache__" || part === ".pytest_cache" || part === ".mypy_cache" ||
      part === ".ruff_cache" || part === ".tox" || part === "htmlcov" || part.endsWith(".egg-info")) return true
  }
  const name = parts[parts.length - 1]
  return name.endsWith(".pyc") || name.endsWith(".pyo") || name === ".coverage"
}

/** 工作间元数据目录（也用于存放失败时的 merge-back 补丁）。 */
export const META_DIR = ".add-feat"

export function sanitizeName(input: string, fallback = "task"): string {
  const out = input
    .replace(/[\s/~^:?*\[\]]+/g, "-")
    .replace(/\.\./g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40)
  return out || fallback
}

export interface IsolationMeta {
  v: 1
  branch: string
  baselineCommit: string
  mergeTarget: string
  createdAt: string
}

export async function writeIsolationMeta(worktreeDir: string, meta: IsolationMeta): Promise<void> {
  await mkdir(join(worktreeDir, META_DIR), { recursive: true })
  await writeFile(join(worktreeDir, META_DIR, "isolation.json"), JSON.stringify(meta, null, 2) + "\n", "utf8")
}

export async function readIsolationMeta(worktreeDir: string): Promise<IsolationMeta | null> {
  try {
    const raw = JSON.parse(await readFile(join(worktreeDir, META_DIR, "isolation.json"), "utf8"))
    if (raw?.v !== 1 || typeof raw.branch !== "string" || typeof raw.baselineCommit !== "string" ||
      typeof raw.mergeTarget !== "string") return null
    return raw as IsolationMeta
  } catch {
    return null
  }
}

/** 未跟踪文件清单（尊重 .gitignore 与缓存排除）。 */
async function listUntracked(run: RunGit, cwd: string): Promise<string[]> {
  const raw = await run(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...cacheExcludeArgs()])
  return raw.split("\0").filter(Boolean).filter((p) => !isCachePath(p)).sort()
}

/** 复制未跟踪文件到目标目录；超过数量/大小上限的跳过并记录。 */
async function copyUntracked(run: RunGit, sourceDir: string, targetDir: string): Promise<{ copied: string[]; skipped: string[] }> {
  const list = await listUntracked(run, sourceDir)
  const copied: string[] = []
  const skipped: string[] = []
  for (const rel of list.slice(0, MAX_UNTRACKED)) {
    try {
      const info = await stat(join(sourceDir, rel))
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        skipped.push(rel)
        continue
      }
      await mkdir(join(targetDir, rel, ".."), { recursive: true })
      await copyFile(join(sourceDir, rel), join(targetDir, rel))
      copied.push(rel)
    } catch {
      skipped.push(rel)
    }
  }
  for (const rel of list.slice(MAX_UNTRACKED)) skipped.push(rel)
  return { copied, skipped }
}

/** 从补丁正文中剔除指定前缀的段（diff --git a/X b/Y 分段）。 */
export function filterPatchSections(patch: string, excludePrefixes: readonly string[]): string {
  const sections = patch.split(/^(?=diff --git )/m)
  return sections
    .filter((section) => {
      const m = section.match(/^diff --git a\/(.+?) b\/(.+?)(?:\s|$)/)
      if (!m) return true
      return ![m[1], m[2]].some((p) => excludePrefixes.some((prefix) => p === prefix || p.startsWith(prefix + "/")))
    })
    .join("")
}

export interface PrepareInput {
  /** 会话当前所在目录（任务起点；也是合并目标）。 */
  sourceDir: string
  slug: string
  run?: RunGit
}

export interface PrepareResult {
  worktreePath: string
  branch: string
  baselineCommit: string
  mergeTarget: string
  inheritedTracked: boolean
  inheritedUntracked: number
  skippedUntracked: string[]
}

/** 创建隔离工作间：worktree add → 继承未提交状态 → 基线快照 commit → 写元数据。 */
export async function prepareIsolation(input: PrepareInput): Promise<PrepareResult> {
  const run = input.run ?? runGitDefault
  const sourceDir = input.sourceDir
  await run(sourceDir, ["rev-parse", "--verify", "HEAD"]) // 无提交仓库直接失败
  const san = sanitizeName(input.slug)
  const suffix = Date.now().toString(36)
  const branch = `add-feat/${san}-${suffix}`
  const worktreePath = join(dirname(sourceDir), `${basename(sourceDir)}-af-${san}-${suffix}`)
  await run(sourceDir, ["worktree", "add", "-b", branch, worktreePath, "HEAD"])

  // 继承已跟踪文件的未提交改动（含暂存区）
  let inheritedTracked = false
  const diffRaw = await run(sourceDir, ["diff", "HEAD", "--binary"])
  if (diffRaw.length > 0) {
    inheritedTracked = true
    const metaDir = join(worktreePath, META_DIR)
    await mkdir(metaDir, { recursive: true })
    const patchPath = join(metaDir, "inherit.patch")
    await writeFile(patchPath, diffRaw, "utf8")
    try {
      await run(worktreePath, ["apply", "--whitespace=nowarn", patchPath])
    } finally {
      await rm(patchPath, { force: true })
    }
  }

  // 继承未跟踪文件（.gitignore 之外；缓存排除）
  const { copied, skipped } = await copyUntracked(run, sourceDir, worktreePath)

  // 基线快照 commit：分支私有，用户授权的例外；主目录零改动
  await run(worktreePath, ["add", "-A"])
  const commitArgs = [
    "-c", "user.name=add-feat", "-c", "user.email=add-feat@local",
    "commit", "--allow-empty", "-q",
    "-m", `add-feat 基线快照（分支私有，不作为合并来源）：${san}`,
  ]
  await run(worktreePath, commitArgs)
  const baselineCommit = (await run(worktreePath, ["rev-parse", "HEAD"])).trim()

  const meta: IsolationMeta = {
    v: 1,
    branch,
    baselineCommit,
    mergeTarget: sourceDir,
    createdAt: new Date().toISOString(),
  }
  await writeIsolationMeta(worktreePath, meta)
  return {
    worktreePath,
    branch,
    baselineCommit,
    mergeTarget: sourceDir,
    inheritedTracked,
    inheritedUntracked: copied.length,
    skippedUntracked: skipped,
  }
}

export interface MergeBackInput {
  worktreeDir: string
  mainDir: string
  branch: string
  baselineCommit: string
  /** 会话身份校验（接线层用 task.ownerSession 比对）。 */
  ownerMatches: boolean
  /** 主树是否存在活动（非终态）add-feat 任务。 */
  mainTaskActive: false | { id: string; phase: string }
  /** 已登记的过程文档等需随合并回到主树的仓库相对路径。
   *  这类文件常被 .gitignore 忽略，不会出现在补丁或未跟踪清单里，必须显式点名搬运。 */
  includePaths?: string[]
  run?: RunGit
  /** 会话迁回主树（接线层调 ctx.session.move）。失败则保留工作间并如实报告。 */
  sessionMove: (directory: string) => Promise<void>
  /** 默认 git worktree remove --force；测试可注入。 */
  removeWorktree?: (mainDir: string, worktreePath: string) => Promise<void>
}

export type MergeBackResult =
  | {
    ok: true
    appliedFiles: string[]
    newFiles: string[]
    /** 来自 includePaths、被忽略/未跟踪但已显式搬运回主树的文件。 */
    includedFiles: string[]
    cleanup: { worktreeRemoved: boolean; branchDeleted: boolean; sessionMovedBack: boolean }
    notes: string[]
  }
  | { ok: false; kind: "refused" | "newfile-conflict" | "apply-failed" | "partial"; message: string; conflicts: string[]; cleanup: { worktreeRemoved: false; branchDeleted: false; sessionMovedBack: boolean } }

/** 校验 includePaths 为安全的仓库相对路径，拒绝绝对路径与 .. 越界。 */
function normalizeIncludePath(raw: string): string | null {
  if (typeof raw !== "string") return null
  const rel = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "")
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return null
  if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) return null
  return rel
}

/** 把工作间任务成果合并回主树。全程不在主树创建 commit（补丁应用保持未提交状态）。 */
export async function mergeBack(input: MergeBackInput): Promise<MergeBackResult> {
  const run = input.run ?? runGitDefault
  const notes: string[] = []
  const kept = { worktreeRemoved: false as const, branchDeleted: false as const, sessionMovedBack: false }

  if (!input.ownerMatches) {
    return { ok: false, kind: "refused", message: "merge_back 只能由创建任务的会话（现处工作间的会话）执行", conflicts: [], cleanup: kept }
  }
  if (input.mainTaskActive) {
    return {
      ok: false,
      kind: "refused",
      message: `主树存在活动 add-feat 任务（${input.mainTaskActive.id.slice(0, 18)}…，${input.mainTaskActive.phase}）；应用补丁会污染其一致性校验，请等它终态后再合并`,
      conflicts: [],
      cleanup: kept,
    }
  }

  // 导出任务改动（相对基线快照；排除元数据目录）
  const patchRaw = await run(input.worktreeDir, ["diff", input.baselineCommit, "--binary"])
  const patch = filterPatchSections(patchRaw, [META_DIR])
  const changedFiles = (await run(input.worktreeDir, ["diff", "--name-only", input.baselineCommit]))
    .split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((p) => p !== META_DIR && !p.startsWith(META_DIR + "/"))
  const newFiles = (await listUntracked(run, input.worktreeDir))
    .filter((p) => p !== META_DIR && !p.startsWith(META_DIR + "/"))

  // 显式点名需随合并回主树的文件（通常是 .gitignore 忽略的过程文档）。
  // 已跟踪文件走补丁，普通未跟踪文件走 newFiles，这里只兜住被忽略的部分。
  const tracked = new Set((await run(input.worktreeDir, ["ls-files", "-z"]))
    .split("\0").filter(Boolean))
  const includedFiles: string[] = []
  for (const raw of input.includePaths ?? []) {
    const rel = normalizeIncludePath(raw)
    if (!rel) continue
    if (rel === META_DIR || rel.startsWith(META_DIR + "/")) continue
    if (tracked.has(rel) || newFiles.includes(rel) || includedFiles.includes(rel)) continue
    try {
      const info = await stat(join(input.worktreeDir, rel))
      if (!info.isFile()) notes.push(`includePaths 指定的不是常规文件，已跳过：${rel}`)
      else if (info.size > MAX_FILE_BYTES) notes.push(`includePaths 指定的文件超过大小上限，已跳过：${rel}`)
      else includedFiles.push(rel)
    } catch {
      notes.push(`includePaths 指定的文件不在工作间，已跳过：${rel}`)
    }
  }

  // 新文件预检：主树同路径已存在且内容不同 → 整体放弃（原子性优先）
  const conflicts: string[] = []
  for (const rel of [...newFiles, ...includedFiles]) {
    try {
      const mainBytes = await readFile(join(input.mainDir, rel))
      const wtBytes = await readFile(join(input.worktreeDir, rel))
      if (!mainBytes.equals(wtBytes)) conflicts.push(rel)
    } catch {
      /* 主树不存在 → 可安全复制 */
    }
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      kind: "newfile-conflict",
      message: `主树已存在同名且内容不同的新文件（${conflicts.join("、")}）；未应用任何改动，请人工核对后处理`,
      conflicts,
      cleanup: kept,
    }
  }

  // 已跟踪补丁：先原子预检，失败尝试 3way，仍失败则保留现场并给补丁路径
  const metaDir = join(input.worktreeDir, META_DIR)
  await mkdir(metaDir, { recursive: true })
  const patchPath = join(metaDir, "merge-back.patch")
  await writeFile(patchPath, patch, "utf8")
  if (patch.length > 0) {
    try {
      await run(input.mainDir, ["apply", "--check", patchPath])
      await run(input.mainDir, ["apply", "--whitespace=nowarn", patchPath])
    } catch {
      try {
        await run(input.mainDir, ["apply", "--3way", patchPath])
        notes.push("已跟踪补丁经 3way 落地；若出现冲突标记需人工解决")
      } catch {
        return {
          ok: false,
          kind: "apply-failed",
          message:
            `补丁无法干净应用到主树（主树自快照以来在这些文件上有变化）。` +
            `未应用任何改动；补丁已保存在工作间 ${META_DIR}/merge-back.patch，` +
            `可人工执行 git apply --3way 或比对后手动融合。冲突/受影响文件见 conflicts 字段（近似：diff --name-only）`,
          conflicts: changedFiles,
          cleanup: kept,
        }
      }
    }
  }

  // 复制新文件（含显式点名的被忽略过程文档）
  for (const rel of [...newFiles, ...includedFiles]) {
    await mkdir(join(input.mainDir, rel, ".."), { recursive: true })
    await copyFile(join(input.worktreeDir, rel), join(input.mainDir, rel))
  }

  // 会话迁回主树，成功后自动清理工作间与分支（用户选择：干净合并即自动删）
  let sessionMovedBack = false
  let worktreeRemoved = false
  let branchDeleted = false
  try {
    await input.sessionMove(input.mainDir)
    sessionMovedBack = true
  } catch (e) {
    notes.push(`会话迁回主树失败（${String(e).slice(0, 120)}）；工作间保留，请手动迁移后再清理`)
  }
  if (sessionMovedBack) {
    try {
      const remove = input.removeWorktree ?? (async (main, wt) => {
        await run(main, ["worktree", "remove", "--force", wt])
      })
      await remove(input.mainDir, input.worktreeDir)
      worktreeRemoved = true
      await run(input.mainDir, ["branch", "-D", input.branch])
      branchDeleted = true
    } catch (e) {
      notes.push(`工作间清理失败（${String(e).slice(0, 120)}）；可稍后手动执行 git worktree remove --force 与 git branch -D`)
    }
  }
  if (notes.length > 0 && sessionMovedBack && !worktreeRemoved) {
    // 清理失败但会话已迁回：任务成果已全部落地，收尾信息如实返回
  }
  return {
    ok: true,
    appliedFiles: changedFiles,
    newFiles,
    includedFiles,
    cleanup: { worktreeRemoved, branchDeleted, sessionMovedBack },
    notes,
  }
}
