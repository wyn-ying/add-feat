import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  filterPatchSections,
  mergeBack,
  prepareIsolation,
  readIsolationMeta,
  sanitizeName,
} from "../src/isolate"

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")}: ${stderr}`))
      else resolve(String(stdout))
    })
  })
}

async function makeSourceRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "addfeat-iso-"))
  const dir = join(base, "repo")
  await mkdir(dir, { recursive: true })
  await git(dir, ["init", "-q", "-b", "main"])
  await git(dir, ["config", "user.email", "t@t"])
  await git(dir, ["config", "user.name", "t"])
  await mkdir(join(dir, "docs"), { recursive: true })
  await writeFile(join(dir, "app.py"), "v1\n")
  await writeFile(join(dir, "docs/note.md"), "n1\n")
  await git(dir, ["add", "."])
  await git(dir, ["commit", "-q", "-m", "base"])
  // 缓存目录放在 base 提交之后：真实场景中它是"未跟踪+被排除"，不应进入基线
  await mkdir(join(dir, "__pycache__"), { recursive: true })
  await writeFile(join(dir, "__pycache__/x.pyc"), "cache\n")
  return dir
}

describe("sanitizeName", () => {
  test("中文保留，空白与 git ref 非法字符转短横线，空串兜底", () => {
    expect(sanitizeName("推店约见设计")).toBe("推店约见设计")
    expect(sanitizeName("a b/c.d")).toBe("a-b-c.d")
    expect(sanitizeName("~~feat: [x]~")).toBe("feat-x")
    expect(sanitizeName("///")).toBe("task")
  })
})

describe("filterPatchSections", () => {
  test("剔除元数据目录段，保留业务段", () => {
    const patch = [
      "diff --git a/.add-feat/isolation.json b/.add-feat/isolation.json",
      "index 000..111",
      "--- a/.add-feat/isolation.json",
      "+++ b/.add-feat/isolation.json",
      "@@ -1 +1 @@",
      "-x",
      "diff --git a/server/app.py b/server/app.py",
      "index 000..222",
      "--- a/server/app.py",
      "+++ b/server/app.py",
      "@@ -1 +1 @@",
      "-v1",
      "+v2",
    ].join("\n")
    const out = filterPatchSections(patch, [".add-feat"])
    expect(out).toContain("server/app.py")
    expect(out).not.toContain("isolation.json")
  })
})

describe("prepareIsolation", () => {
  test("建工作间：继承已跟踪改动与未跟踪文件，排除缓存；基线快照与元数据落地", async () => {
    const source = await makeSourceRepo()
    try {
      // 快照前主树状态：已跟踪改动 + 未跟踪新文件 + 缓存
      await writeFile(join(source, "app.py"), "v2-dirty\n")
      await writeFile(join(source, "docs/draft.md"), "草稿\n")
      const r = await prepareIsolation({ sourceDir: source, slug: "推店约见设计" })
      const wt = r.worktreePath
      expect(r.branch).toBe(`add-feat/推店约见设计-${r.branch.split("-").pop()}`)
      expect(r.mergeTarget).toBe(source)
      // 已跟踪改动被继承（工作间文件是脏版本，且相对基线的 diff 记录了它）
      expect(await readFile(join(wt, "app.py"), "utf8")).toBe("v2-dirty\n")
      // 未跟踪新文件被复制
      expect(await readFile(join(wt, "docs/draft.md"), "utf8")).toBe("草稿\n")
      expect(r.inheritedUntracked).toBe(1)
      // 缓存不继承
      expect(existsSync(join(wt, "__pycache__"))).toBe(false)
      // 基线 commit 存在且工作间干净
      expect(r.baselineCommit).toMatch(/^[0-9a-f]{40}$/)
      // 工作间唯一未跟踪项 = 元数据目录（基线后写入，合并时被排除）
      expect((await git(wt, ["status", "--porcelain"])).trim()).toBe("?? .add-feat/")
      // 元数据可读
      const meta = await readIsolationMeta(wt)
      expect(meta?.branch).toBe(r.branch)
      expect(meta?.baselineCommit).toBe(r.baselineCommit)
      expect(meta?.mergeTarget).toBe(source)
      // 主目录零改动（除原有脏状态）：分支列表含新分支
      expect(await git(source, ["branch", "--list", r.branch])).toContain(r.branch.slice(0, 20))
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })
  test("干净主树也能建工作间（允许空快照 commit）", async () => {
    const source = await makeSourceRepo()
    try {
      const r = await prepareIsolation({ sourceDir: source, slug: "clean" })
      expect(r.inheritedTracked).toBe(false)
      expect(r.baselineCommit).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })
})

describe("mergeBack", () => {
  async function makePair() {
    const source = await makeSourceRepo()
    const prepared = await prepareIsolation({ sourceDir: source, slug: "demo" })
    return { source, prepared }
  }
  const io = { sessionMove: async () => {} }

  test("干净合并：补丁+新文件落地主树（保持未提交），工作间与分支自动清理，会话迁回", async () => {
    const { source, prepared } = await makePair()
    try {
      const wt = prepared.worktreePath
      await writeFile(join(wt, "app.py"), "v3-task\n")
      await writeFile(join(wt, "docs/new-file.md"), "新文件\n")
      let movedTo = ""
      const r = await mergeBack({
        worktreeDir: wt,
        mainDir: source,
        branch: prepared.branch,
        baselineCommit: prepared.baselineCommit,
        ownerMatches: true,
        mainTaskActive: false,
        sessionMove: async (d) => { movedTo = d },
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.appliedFiles).toContain("app.py")
        expect(r.newFiles).toContain("docs/new-file.md")
        expect(r.cleanup.sessionMovedBack).toBe(true)
        expect(r.cleanup.worktreeRemoved).toBe(true)
        expect(r.cleanup.branchDeleted).toBe(true)
      }
      expect(movedTo).toBe(source)
      // 主树拿到任务改动，保持未提交
      expect(await readFile(join(source, "app.py"), "utf8")).toBe("v3-task\n")
      expect(await readFile(join(source, "docs/new-file.md"), "utf8")).toBe("新文件\n")
      const status = await git(source, ["status", "--porcelain"])
      expect(status).toContain(" M app.py")
      expect(status).toContain("?? docs/new-file.md")
      // 工作间与分支已删
      expect(existsSync(wt)).toBe(false)
      expect((await git(source, ["branch", "--list", prepared.branch])).trim()).toBe("")
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })
  test("主树同文件已漂移→整体放弃，主树零改动，工作间与补丁保留", async () => {
    const { source, prepared } = await makePair()
    try {
      const wt = prepared.worktreePath
      await writeFile(join(wt, "app.py"), "v3-task\n")
      // 主树在快照后独立改了同一文件
      await writeFile(join(source, "app.py"), "v2-main-drift\n")
      const r = await mergeBack({
        worktreeDir: wt, mainDir: source, branch: prepared.branch,
        baselineCommit: prepared.baselineCommit, ownerMatches: true, mainTaskActive: false,
        sessionMove: io.sessionMove,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.kind).toBe("apply-failed")
      // 主树保持原样（原子放弃）
      expect(await readFile(join(source, "app.py"), "utf8")).toBe("v2-main-drift\n")
      // 工作间与补丁保留，供人工融合
      expect(existsSync(wt)).toBe(true)
      expect(existsSync(join(wt, ".add-feat", "merge-back.patch"))).toBe(true)
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })
  test("主树已有同名不同内容的新文件→整体放弃", async () => {
    const { source, prepared } = await makePair()
    try {
      const wt = prepared.worktreePath
      await writeFile(join(wt, "docs/new-file.md"), "工作间版本\n")
      await writeFile(join(source, "docs/new-file.md"), "主树版本\n")
      const r = await mergeBack({
        worktreeDir: wt, mainDir: source, branch: prepared.branch,
        baselineCommit: prepared.baselineCommit, ownerMatches: true, mainTaskActive: false,
        sessionMove: io.sessionMove,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.kind).toBe("newfile-conflict")
      expect(await readFile(join(source, "docs/new-file.md"), "utf8")).toBe("主树版本\n")
      expect(existsSync(wt)).toBe(true)
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })
  async function makeIgnoredPair() {
    const source = await makeSourceRepo()
    await writeFile(join(source, ".gitignore"), "docs/cowork/**/dev.*\ndocs/cowork/**/audit.*\n*.log\n")
    await git(source, ["add", ".gitignore"])
    await git(source, ["commit", "-q", "-m", "ignore process docs"])
    const prepared = await prepareIsolation({ sourceDir: source, slug: "demo" })
    return { source, prepared }
  }

  test("被 .gitignore 忽略的已登记过程文档仍随合并回到主树，未登记忽略文件不搬运", async () => {
    const { source, prepared } = await makeIgnoredPair()
    try {
      const wt = prepared.worktreePath
      const dev = "docs/cowork/演示_2026-11-06/dev.v1.r1.2026-11-06.md"
      const audit = "docs/cowork/演示_2026-11-06/audit.v1.r1.2026-11-06.md"
      await mkdir(join(wt, "docs/cowork/演示_2026-11-06"), { recursive: true })
      await writeFile(join(wt, dev), "开发记录\n")
      await writeFile(join(wt, audit), "审计记录\n")
      await writeFile(join(wt, "notes.local.log"), "无关日志\n")
      const r = await mergeBack({
        worktreeDir: wt, mainDir: source, branch: prepared.branch,
        baselineCommit: prepared.baselineCommit, ownerMatches: true, mainTaskActive: false,
        includePaths: [dev, audit],
        sessionMove: io.sessionMove,
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.includedFiles).toEqual([dev, audit])
        expect(r.newFiles).not.toContain(dev)
      }
      // 文档回到主树，但继续保持被忽略（不进入提交）
      expect(await readFile(join(source, dev), "utf8")).toBe("开发记录\n")
      expect(await readFile(join(source, audit), "utf8")).toBe("审计记录\n")
      expect((await git(source, ["check-ignore", dev])).trim().length).toBeGreaterThan(0)
      expect(await git(source, ["status", "--porcelain"])).not.toContain("docs/cowork")
      // 未登记的忽略文件不搬运
      expect(existsSync(join(source, "notes.local.log"))).toBe(false)
      // 工作间已清理
      expect(existsSync(wt)).toBe(false)
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })

  test("主树同路径已存在不同内容的过程文档→整体放弃且不覆盖", async () => {
    const { source, prepared } = await makeIgnoredPair()
    try {
      const wt = prepared.worktreePath
      const dev = "docs/cowork/演示_2026-11-06/dev.v1.r1.2026-11-06.md"
      await mkdir(join(wt, "docs/cowork/演示_2026-11-06"), { recursive: true })
      await writeFile(join(wt, dev), "工作间版本\n")
      await mkdir(join(source, "docs/cowork/演示_2026-11-06"), { recursive: true })
      await writeFile(join(source, dev), "主树人工版本\n")
      const r = await mergeBack({
        worktreeDir: wt, mainDir: source, branch: prepared.branch,
        baselineCommit: prepared.baselineCommit, ownerMatches: true, mainTaskActive: false,
        includePaths: [dev],
        sessionMove: io.sessionMove,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.kind).toBe("newfile-conflict")
        expect(r.conflicts).toContain(dev)
      }
      expect(await readFile(join(source, dev), "utf8")).toBe("主树人工版本\n")
      expect(existsSync(wt)).toBe(true)
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })

  test("非法或越界的 includePaths 被忽略，不会写到主树之外", async () => {
    const { source, prepared } = await makeIgnoredPair()
    try {
      const wt = prepared.worktreePath
      const r = await mergeBack({
        worktreeDir: wt, mainDir: source, branch: prepared.branch,
        baselineCommit: prepared.baselineCommit, ownerMatches: true, mainTaskActive: false,
        includePaths: ["../escape.md", "/etc/passwd", ".add-feat/isolation.json"],
        sessionMove: io.sessionMove,
      })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.includedFiles).toEqual([])
      expect(existsSync(join(source, "..", "escape.md"))).toBe(false)
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })

  test("拒绝：非属主会话 / 主树活动任务", async () => {
    const { source, prepared } = await makePair()
    try {
      const base = { worktreeDir: prepared.worktreePath, mainDir: source, branch: prepared.branch, baselineCommit: prepared.baselineCommit }
      const r1 = await mergeBack({ ...base, ownerMatches: false, mainTaskActive: false, sessionMove: io.sessionMove })
      expect(r1.ok).toBe(false)
      const r2 = await mergeBack({ ...base, ownerMatches: true, mainTaskActive: { id: "af-x", phase: "audit_running" }, sessionMove: io.sessionMove })
      expect(r2.ok).toBe(false)
      if (!r2.ok) expect(r2.message).toContain("活动 add-feat 任务")
      expect(existsSync(prepared.worktreePath)).toBe(true)
      // 主树零改动（缓存目录本就未跟踪）
      expect((await git(source, ["status", "--porcelain"])).trim()).toBe("?? __pycache__/")
    } finally {
      await rm(dirname(source), { recursive: true, force: true })
    }
  })
})
