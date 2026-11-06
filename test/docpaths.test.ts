import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { verifyProcessOutputs, workspaceDigest } from "../src/wsdiff"
import { DEFAULT_DOC_RULES, renderDocPaths, renderTemplate, safeDocPath, validateDocRules, validateTaskSlug } from "../src/docpaths"

function git(cwd: string, cmd: string) {
  execSync(`git -c user.name=T -c user.email=t@i ${cmd}`, { cwd, stdio: "pipe" })
}

function freshRepo(): string {
  const dir = join(tmpdir(), `addfeat-repo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  git(dir, "init -q .")
  writeFileSync(join(dir, "app.py"), "x = 1\n")
  git(dir, "add -A")
  git(dir, "commit -qm base")
  return dir
}

describe("workspace 摘要与差异", () => {
  test("测试缓存不影响摘要；真实改动影响", async () => {
    const dir = freshRepo()
    try {
      const clean = await workspaceDigest(dir)
      expect(clean).toBeTruthy()
      mkdirSync(join(dir, "__pycache__"), { recursive: true })
      writeFileSync(join(dir, "__pycache__/app.cpython-311.pyc"), "junk")
      mkdirSync(join(dir, ".pytest_cache"), { recursive: true })
      writeFileSync(join(dir, ".pytest_cache/CACHEDIR.TAG"), "junk")
      writeFileSync(join(dir, "app.py.bak.pyc"), "junk")
      expect(await workspaceDigest(dir)).toBe(clean)
      writeFileSync(join(dir, "app.py"), "x = 2\n")
      expect(await workspaceDigest(dir)).not.toBe(clean)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("新增未跟踪源文件计入摘要", async () => {
    const dir = freshRepo()
    try {
      const before = await workspaceDigest(dir)
      writeFileSync(join(dir, "new_module.py"), "y = 1\n")
      expect(await workspaceDigest(dir)).not.toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("排除区：登记路径不可见，同目录邻居仍可见（含 tracked diff 分段过滤）", async () => {
    const dir = freshRepo()
    try {
      const base = await workspaceDigest(dir)
      // 未跟踪排除：登记路径不可见
      mkdirSync(join(dir, "docs/任务_2026-10-31"), { recursive: true })
      writeFileSync(join(dir, "docs/任务_2026-10-31/plan.v1.r1.2026-10-31.md"), "# plan\n")
      const excludes = ["docs/任务_2026-10-31/plan.v1.r1.2026-10-31.md"]
      expect(await workspaceDigest(dir, excludes)).toBe(base)
      // 同目录邻居文件不被排除
      writeFileSync(join(dir, "docs/任务_2026-10-31/dev.v1.r1.2026-10-31.md"), "# dev\n")
      expect(await workspaceDigest(dir, excludes)).not.toBe(base)
      // tracked 文件修改默认可见；登记后不可见（共享索引场景）——独立验证避免邻居污染
      const dir2 = freshRepo()
      try {
        const base2 = await workspaceDigest(dir2)
        writeFileSync(join(dir2, "app.py"), "x = 2\n")
        expect(await workspaceDigest(dir2)).not.toBe(base2)
        expect(await workspaceDigest(dir2, ["app.py"])).toBe(base2)
      } finally {
        rmSync(dir2, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("多条目状态解析：排除不因记录串接失效（真实冒烟回归）", async () => {
    const dir = freshRepo()
    try {
      mkdirSync(join(dir, "过程记录/中文问候_2026-10-31"), { recursive: true })
      writeFileSync(join(dir, "app.py"), "x = 2\n") // tracked 修改放最前，复现"首条目 tracked+多条未跟踪"
      const ex = ["过程记录/中文问候_2026-10-31/审计.r1.2026-10-31.md"]
      writeFileSync(join(dir, "过程记录/中文问候_2026-10-31/审计.r1.2026-10-31.md"), "# audit\n")
      const withDoc = await workspaceDigest(dir, ex)
      rmSync(join(dir, "过程记录/中文问候_2026-10-31/审计.r1.2026-10-31.md"))
      const withoutDoc = await workspaceDigest(dir, ex)
      expect(withDoc).toBe(withoutDoc) // 排除路径在场与否，摘要必须一致
      // 邻居可见
      writeFileSync(join(dir, "过程记录/中文问候_2026-10-31/开发.r1.2026-10-31.md"), "# dev\n")
      expect(await workspaceDigest(dir, ex)).not.toBe(withoutDoc)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("verifyProcessOutputs：改动/缺失可检出", async () => {
    const dir = freshRepo()
    try {
      const rel = "docs/任务/plan.md"
      mkdirSync(join(dir, "docs/任务"), { recursive: true })
      const content = "# plan\n"
      writeFileSync(join(dir, rel), content)
      const sha = createHash("sha256").update(content).digest("hex")
      expect(await verifyProcessOutputs(dir, { [rel]: sha })).toBe(true)
      expect(await verifyProcessOutputs(dir, { [rel]: "deadbeef" })).toBe(false)
      expect(await verifyProcessOutputs(dir, { "docs/missing.md": sha })).toBe(false)
      writeFileSync(join(dir, rel), "# tampered\n")
      expect(await verifyProcessOutputs(dir, { [rel]: sha })).toBe(false)
      void readFile
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("procdocs 规则", () => {
  test("默认规则渲染", () => {
    const p = renderDocPaths(DEFAULT_DOC_RULES, { task: "用户资料", dirDate: "2026-10-31", fileDate: "2026-11-02", round: 2 })
    expect(p.plan).toBe("docs/cowork/用户资料_2026-10-31/plan.v1.r1.2026-11-02.md")
    expect(p.dev).toBe("docs/cowork/用户资料_2026-10-31/dev.v1.r2.2026-11-02.md")
    expect(p.audit).toBe("docs/cowork/用户资料_2026-10-31/audit.v1.r2.2026-11-02.md")
    expect(p.delivery).toBe("docs/cowork/用户资料_2026-10-31/delivery_v1.2026-11-02.md")
    expect(p.index).toBe("docs/cowork/README.md")
  })
  test("自定义中文规则渲染（换项目自动遵守另一套约定）", () => {
    const rules = validateDocRules({
      dir: "过程记录/{task}_{date}",
      plan: "计划.r1.{date}.md",
      dev: "开发.r{round}.md",
      audit: "审计.r{round}.md",
      delivery: null,
      taskReadme: null,
      index: null,
    })
    expect(rules.rules).toBeTruthy()
    const p = renderDocPaths(rules.rules!, { task: "登录", dirDate: "2026-11-01", fileDate: "2026-11-03", round: 3 })
    expect(p.plan).toBe("过程记录/登录_2026-11-01/计划.r1.2026-11-03.md")
    expect(p.dev).toBe("过程记录/登录_2026-11-01/开发.r3.md")
    expect(p.audit).toBe("过程记录/登录_2026-11-01/审计.r3.md")
    expect(p.delivery).toBeNull()
  })
  test("非法规则拒绝", () => {
    expect(validateDocRules(null).error).toBeTruthy()
    expect(validateDocRules({ dir: "a", plan: "p", dev: "d" }).error).toBeTruthy()
    expect(validateDocRules({ dir: "a", plan: "../p", dev: "d", audit: "x" }).error).toBeTruthy()
    expect(validateDocRules({ dir: "a", plan: "p", dev: "d", audit: "x", index: "../i.md" }).error).toBeTruthy()
  })
  test("taskSlug 校验", () => {
    expect(validateTaskSlug("用户资料")!.slug).toBe("用户资料")
    expect(validateTaskSlug("user-profile")!.slug).toBe("user-profile")
    expect(validateTaskSlug(undefined)!.slug).toBe("task")
    expect(validateTaskSlug("a b").error).toBeTruthy()
    expect(validateTaskSlug("a.b").error).toBeTruthy()
    expect(validateTaskSlug("a_b").error).toBeTruthy()
    expect(validateTaskSlug("x".repeat(41)).error).toBeTruthy()
  })
})

describe("字面量护栏（真实事故 3 回归）", () => {
  test("漏传变量时 renderTemplate 抛错而非保留 {date}", () => {
    expect(() => renderTemplate("d/{task}_{date}", { task: "x" })).toThrow("字面量")
    expect(renderTemplate("d/{task}_{date}", { task: "x", date: "2026-11-01" })).toBe("d/x_2026-11-01")
  })
  test("safeDocPath 拒绝花括号路径（写入前第二道网）", () => {
    expect(safeDocPath("docs/cowork/user-profile_{date}/delivery_v1.{date}.md")).toBe(false)
    expect(safeDocPath("docs/cowork/任务_2026-11-01/dev.v1.r1.2026-11-01.md")).toBe(true)
  })
})

describe("模板与渲染校验分离", () => {
  test("validateDocRules 接受含 {date} 的 delivery/index 模板；渲染后路径拒绝花括号", () => {
    const r = validateDocRules({ dir: "d/{task}_{date}", plan: "p.{date}.md", dev: "d.r{round}.md", audit: "a.r{round}.md", delivery: "delivery_v1.{date}.md", taskReadme: "README.md", index: "d/索引.md" })
    expect(r.rules).toBeTruthy()
    expect(safeDocPath("d/任务_2026-11-01/delivery_v1.{date}.md")).toBe(false)
    const p = renderDocPaths(r.rules!, { task: "任务", round: 1, dirDate: "2026-11-01", fileDate: "2026-11-01" })
    expect(p.delivery).toBe("d/任务_2026-11-01/delivery_v1.2026-11-01.md")
  })
})
