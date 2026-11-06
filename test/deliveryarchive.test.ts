import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveDelivery } from "../src/deliveryarchive"

describe("交付旧正文备份", () => {
  test("保留原字节、来源及哈希，备份唯一且私有，不改原文", async () => {
    await mkdir(tmpdir(), { recursive: true })
    const base = await mkdtemp(join(tmpdir(), "addfeat-delivery-"))
    try {
      const repo = join(base, "repo")
      await mkdir(repo)
      const bytes = Buffer.from("# 旧正文\r\n未经人工确认\n")
      await writeFile(join(repo, "delivery.md"), bytes)
      const hash = createHash("sha256").update(bytes).digest("hex")
      const root = join(base, "state")
      const first = await archiveDelivery(root, repo, "delivery.md", hash)
      const second = await archiveDelivery(root, repo, "delivery.md", hash)
      expect(first).not.toBe(second)
      const backup = JSON.parse(await readFile(first, "utf8"))
      expect(Buffer.from(backup.contentBase64, "base64")).toEqual(bytes)
      expect(backup.repository).toBe(repo)
      expect(backup.path).toBe("delivery.md")
      expect(backup.hash).toBe(hash)
      expect((await stat(first)).mode & 0o777).toBe(0o600)
      expect(await readFile(join(repo, "delivery.md"))).toEqual(bytes)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
  test("旧正文变化、缺失、非法路径、备份存储失败均报错且不覆盖", async () => {
    await mkdir(tmpdir(), { recursive: true })
    const base = await mkdtemp(join(tmpdir(), "addfeat-delivery-"))
    try {
      const root = join(base, "state")
      await mkdir(root)
      await writeFile(join(base, "delivery.md"), "原正文")
      const hash = createHash("sha256").update("原正文").digest("hex")
      await expect(archiveDelivery(root, base, "delivery.md", "wrong")).rejects.toThrow("哈希")
      await expect(archiveDelivery(root, base, "missing.md", hash)).rejects.toThrow()
      await expect(archiveDelivery(root, base, "../delivery.md", hash)).rejects.toThrow("非法")
      expect(await readdir(root)).toHaveLength(0)
      await writeFile(join(root, "delivery-revisions"), "阻塞目录创建")
      await expect(archiveDelivery(root, base, "delivery.md", hash)).rejects.toThrow()
      expect(await readFile(join(base, "delivery.md"), "utf8")).toBe("原正文")
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
