import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathInScope, workspaceDigest, workspaceDiff } from "../src/wsdiff"

async function ensureTmp() {
  await mkdir(tmpdir(), { recursive: true })
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")}: ${stderr}`))
      else resolve(String(stdout))
    })
  })
}

describe("pathInScope（allowedPaths 范围匹配）", () => {
  const scope = ["server/src/profiles/**", "server/src/app.py", "web/src/api/"]
  test("目录前缀 / 精确文件 / 尾部通配与斜杠归一", () => {
    expect(pathInScope("server/src/profiles/service.py", scope)).toBe(true)
    expect(pathInScope("server/src/app.py", scope)).toBe(true)
    expect(pathInScope("web/src/api/user-profile.js", scope)).toBe(true)
    expect(pathInScope("server/src/accounts/service.py", scope)).toBe(false)
    expect(pathInScope("server/src/profiles_extra.py", scope)).toBe(false) // 前缀伪同名录不误配
    expect(pathInScope("docs/cowork/README.md", scope)).toBe(false)
    expect(pathInScope("anything", [])).toBe(true) // 空范围 = 全域
  })
})

describe("workspaceDigest 范围作用（范围内强制/范围外观察）", () => {
  test("范围外变化不影响 scoped 摘要；范围内变化与 HEAD 变化影响；full 摘要捕捉全域", async () => {
    await ensureTmp()
    const base = await mkdtemp(join(tmpdir(), "addfeat-scope-"))
    try {
      const repo = join(base, "repo")
      await mkdir(repo)
      await git(repo, ["init", "-q"])
      await git(repo, ["config", "user.email", "t@t"])
      await git(repo, ["config", "user.name", "t"])
      await mkdir(join(repo, "server/src/profiles"), { recursive: true })
      await mkdir(join(repo, "docs/other"), { recursive: true })
      await writeFile(join(repo, "server/src/profiles/service.py"), "v1\n")
      await writeFile(join(repo, "docs/other/note.md"), "n1\n")
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-q", "-m", "base"])

      const scope = ["server/src/profiles/**"]
      const d1full = await workspaceDigest(repo, [], undefined)
      const d1scoped = await workspaceDigest(repo, [], scope)
      expect(d1full).toBeTruthy()
      expect(d1scoped).toBeTruthy()

      // ① 范围外已跟踪文件变化：scoped 不变，full 变
      await writeFile(join(repo, "docs/other/note.md"), "n2\n")
      expect(await workspaceDigest(repo, [], scope)).toBe(d1scoped)
      expect(await workspaceDigest(repo, [], undefined)).not.toBe(d1full)

      // ② 范围外未跟踪新文件：scoped 不变，full 变
      await writeFile(join(repo, "docs/other/new.md"), "x\n")
      expect(await workspaceDigest(repo, [], scope)).toBe(d1scoped)

      // ③ 范围内变化：scoped 变（强制判定的基础）
      await writeFile(join(repo, "server/src/profiles/service.py"), "v2\n")
      const d3 = await workspaceDigest(repo, [], scope)
      expect(d3).not.toBe(d1scoped)

      // ④ HEAD 变化（提交）：scoped 也变——范围含 HEAD
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-q", "-m", "c2"])
      expect(await workspaceDigest(repo, [], scope)).not.toBe(d3)

      // ⑤ 全域观察（diff_meta 数据源）仍列出范围外文件
      await writeFile(join(repo, "docs/other/note.md"), "n3\n")
      const meta = await workspaceDiff(repo)
      expect(meta.status).toContain("docs/other/note.md")
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
