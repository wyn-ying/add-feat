/** git 工作区摘要与可信差异（v2：精确排除本任务过程文档）。
 * 目的：检测"阶段之间代码是否变化"，不是加密级快照。
 * 排除规则：仅排除 state 中登记的**精确路径**（防篡改盲区由 verifyProcessOutputs 的
 * 内容哈希复核关闭）；未跟踪测试缓存不算业务改动；已跟踪文件变化始终计入（除非
 * 恰为本任务登记的过程文档，例如共享索引的追加）。 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

const MAX_UNTRACKED = 500
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** 未跟踪缓存排除模式（git pathspec glob）。 */
const CACHE_EXCLUDES = [
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".coverage",
  "htmlcov/",
  "*.egg-info/",
  ".tox/",
]

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]}: ${String(stderr).slice(0, 300)}`))
        else resolve(String(stdout))
      },
    )
  })
}

function cacheExcludeArgs(): string[] {
  return CACHE_EXCLUDES.flatMap((pattern) => ["--exclude", pattern])
}

function isCachePath(path: string): boolean {
  const parts = path.split("/")
  for (const part of parts) {
    if (
      part === "__pycache__" || part === ".pytest_cache" || part === ".mypy_cache" ||
      part === ".ruff_cache" || part === ".tox" || part === "htmlcov" || part.endsWith(".egg-info")
    ) return true
  }
  const name = parts[parts.length - 1]
  return name.endsWith(".pyc") || name.endsWith(".pyo") || name === ".coverage"
}

/** porcelain -z 解析：每个条目 NUL 结尾；R/C 状态额外跟第二个路径字段。
 * 逐条独立解析（此前实现把多条目串接成一条，导致排除失灵——真实冒烟抓出）。 */
function filterStatus(
  raw: string,
  excludes: ReadonlySet<string>,
  include?: (path: string) => boolean,
): { kept: string; dirtyCount: number } {
  const fields = raw.split("\0")
  const keptRecords: string[] = []
  let i = 0
  while (i < fields.length && fields[i] !== "") {
    let record = fields[i]
    i += 1
    const status = record.slice(0, 2)
    if (status.includes("R") || status.includes("C")) {
      if (i < fields.length && fields[i] !== "") {
        record += "\0" + fields[i]
        i += 1
      }
    }
    const path = record.slice(3).split("\0")[0]
    if (excludes.has(path)) continue
    if (status === "??" && isCachePath(path)) continue
    if (include && !include(path)) continue
    keptRecords.push(record)
  }
  return { kept: keptRecords.join("\0"), dirtyCount: keptRecords.length }
}

/** 按 `diff --git a/X b/X` 分段；丢弃排除路径的段（解析失败保留=偏安全）。 */
function filterDiffSections(
  raw: string,
  excludes: ReadonlySet<string>,
  include?: (path: string) => boolean,
): string {
  if (excludes.size === 0 && !include) return raw
  const sections = raw.split(/^(?=diff --git )/m)
  return sections
    .filter((section) => {
      const m = section.match(/^diff --git a\/(.+?) b\/(.+?)(?:\s|$)/)
      if (!m) return true
      if (excludes.has(m[1]) || excludes.has(m[2])) return false
      if (include && !include(m[1]) && !include(m[2])) return false
      return true
    })
    .join("")
}

/** allowedPaths 范围匹配：条目去掉尾部 `/**`、`/*` 或 `/` 后按精确文件/目录前缀匹配。
 *  空列表 = 不限范围（全域）。不支持条目中间的通配符（计划实践上均为目录/文件前缀）。 */
export function pathInScope(path: string, includePaths: readonly string[]): boolean {
  if (includePaths.length === 0) return true
  for (const raw of includePaths) {
    const base = raw.replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/\/$/, "")
    if (!base) continue
    if (path === base || path.startsWith(base + "/")) return true
  }
  return false
}

/** 全域摘要（或按 includePaths 限定范围）：head + 范围内 status/diff/未跟踪内容。
 *  includePaths 非空时仅范围内变化计入哈希——用于"任务范围内一致性强制"；
 *  范围外漂移由调用方另行观察（警告），不进入强制摘要。 */
export async function workspaceDigest(
  cwd: string,
  excludePaths: readonly string[] = [],
  includePaths?: readonly string[],
): Promise<string | null> {
  try {
    const excludes = new Set(excludePaths)
    const include = includePaths && includePaths.length > 0 ? (p: string) => pathInScope(p, includePaths) : undefined
    const head = await run(cwd, ["rev-parse", "HEAD"])
    const statusRaw = await run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    const { kept: status, dirtyCount } = filterStatus(statusRaw, excludes, include)
    const diffRaw = await run(cwd, ["diff", "HEAD", "--no-ext-diff", "--no-color"])
    const diff = filterDiffSections(diffRaw, excludes, include)
    const untracked = (
      await run(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...cacheExcludeArgs()])
    )
      .split("\0")
      .filter(Boolean)
      .filter((p) => !excludes.has(p))
      .filter((p) => !include || include(p))
    const hash = createHash("sha256")
    hash.update(head)
    hash.update("\0S\0")
    hash.update(status)
    hash.update("\0D\0")
    hash.update(diff)
    hash.update("\0U\0")
    if (untracked.length > MAX_UNTRACKED) {
      hash.update(`too-many:${untracked.length}`)
    } else {
      for (const rel of untracked.sort()) {
        hash.update(rel)
        hash.update("=")
        try {
          const buf = await readFile(`${cwd}/${rel}`)
          hash.update(
            buf.length > MAX_FILE_BYTES ? `big:${buf.length}` : createHash("sha256").update(buf).digest("hex"),
          )
        } catch {
          hash.update("unreadable")
        }
        hash.update("\0")
      }
    }
    return `${hash.digest("hex")}|dirty=${dirtyCount}`
  } catch {
    return null
  }
}

/** 已登记过程文档是否完好：存在且内容哈希一致。 */
export async function verifyProcessOutputs(
  cwd: string,
  outputs: Record<string, string>,
): Promise<boolean> {
  for (const [rel, expected] of Object.entries(outputs)) {
    try {
      const buf = await readFile(`${cwd}/${rel}`)
      if (createHash("sha256").update(buf).digest("hex") !== expected) return false
    } catch {
      return false
    }
  }
  return true
}

/** 可信差异：状态清单 + 统计 + 分片差异。
 * diffFull 为有界全文（≤2MB，供 index 按 part 分片转述给只读审计者）；
 * diff 保持 60KB 兼容视图 + truncated 标记；各清单截断情况单独如实标记。 */
export async function workspaceDiff(cwd: string): Promise<{
  status: string
  stat: string
  diff: string
  diffFull: string
  truncated: boolean
  untracked: string[]
  statusTruncated: boolean
  statTruncated: boolean
  untrackedTruncated: boolean
  diffHardTruncated: boolean
}> {
  const [statusRaw, stat, diffRaw, untrackedRaw] = await Promise.all([
    run(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    run(cwd, ["diff", "HEAD", "--stat", "--no-ext-diff", "--no-color"]),
    run(cwd, ["diff", "HEAD", "--no-ext-diff", "--no-color"]),
    run(cwd, ["ls-files", "--others", "--exclude-standard", ...cacheExcludeArgs()]),
  ])
  const CAP = 60 * 1024
  const HARD = 2 * 1024 * 1024
  const statusLines = statusRaw
    .split("\n")
    .filter((line) => line.trim() !== "" && !(line.startsWith("??") && isCachePath(line.slice(3))))
  const statusJoined = statusLines.join("\n")
  const untrackedList = untrackedRaw.split("\n").filter(Boolean)
  return {
    status: statusJoined.slice(0, 8192),
    stat: stat.slice(0, 8192),
    diff: diffRaw.slice(0, CAP),
    diffFull: diffRaw.slice(0, HARD),
    truncated: diffRaw.length > CAP,
    untracked: untrackedList.slice(0, 200),
    statusTruncated: statusJoined.length > 8192,
    statTruncated: stat.length > 8192,
    untrackedTruncated: untrackedList.length > 200,
    diffHardTruncated: diffRaw.length > HARD,
  }
}
