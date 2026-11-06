import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyStore, loadStore, saveStore, statePath } from "../src/storefile"
import type { Store } from "../src/workflow"

function root(): string {
  const dir = join(tmpdir(), `addfeat-store-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function sample(locationDir: string): Store {
  const s = emptyStore(locationDir)
  s.task = {
    id: "af-x", requirement: "合法长度需求", maxRepairs: 4, phase: "dev_running",
    createdAt: "2026-10-31T00:00:00Z", startDate: "2026-10-31", taskSlug: "t",
    docRules: { dir: "d/{task}", plan: "p.md", dev: "d.md", audit: "a.md" },
    processOutputs: {}, repairsUsed: 0, findings: [], checks: [], log: [],
  }
  return s
}

describe("storefile 防清空守卫", () => {
  test("正常往返：保存后加载还原任务", async () => {
    const r = root()
    try {
      const s = sample("/repo")
      await saveStore(r, s, true)
      const loaded = await loadStore(r, "/repo")
      expect(loaded.ok).toBe(true)
      expect(loaded.store.task?.id).toBe("af-x")
      expect(loaded.store.task?.phase).toBe("dev_running")
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
  test("文件不存在：ok=true 空目录", async () => {
    const r = root()
    try {
      const loaded = await loadStore(r, "/new")
      expect(loaded.ok).toBe(true)
      expect(loaded.store.task).toBeNull()
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
  test("损坏文件：ok=false 且禁止写回，原文件字节保留", async () => {
    const r = root()
    try {
      const path = statePath(r, "/repo")
      writeFileSync(path, "{broken json")
      const loaded = await loadStore(r, "/repo")
      expect(loaded.ok).toBe(false)
      expect(loaded.reason).toContain("损坏")
      await expect(saveStore(r, loaded.store, loaded.ok)).rejects.toThrow("防清空")
      expect(readFileSync(path, "utf8")).toBe("{broken json")
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
  test("版本不符 / 目录键不符：同样拒绝写回", async () => {
    const r = root()
    try {
      const path = statePath(r, "/repo")
      writeFileSync(path, JSON.stringify({ version: 1, locationDir: "/repo", task: null, history: [] }))
      let loaded = await loadStore(r, "/repo")
      expect(loaded.ok).toBe(false)
      await expect(saveStore(r, loaded.store, loaded.ok)).rejects.toThrow()
      writeFileSync(path, JSON.stringify({ version: 2, locationDir: "/other", task: null, history: [] }))
      loaded = await loadStore(r, "/repo")
      expect(loaded.ok).toBe(false)
      expect(loaded.reason).toContain("目录键")
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
})
