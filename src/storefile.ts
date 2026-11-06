/** 状态文件持久化（v2.1.1：防清空守卫）。
 *
 * 教训（真实事故 2026-10-31）：loadStore 解析失败/版本不匹配时返回空 store，
 * 若调用方仍"无条件落盘"（B1），一次读取抖动就会把空 store 写回真实文件，
 * 活任务被彻底清空。因此：load 失败 → 永不写回（read-only 报错），原文件保留。 */
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Store } from "./flowcore"

export interface LoadResult {
  store: Store
  /** false=文件存在但不可用（损坏/版本不符/目录不符）→ 调用方不得保存。 */
  ok: boolean
  reason?: string
}

export function statePath(stateRoot: string, locationDir: string): string {
  const key = createHash("sha256").update(locationDir).digest("hex").slice(0, 16)
  return join(stateRoot, `state-${key}.json`)
}

export function emptyStore(locationDir: string): Store {
  return { version: 2, locationDir, task: null, history: [] }
}

export async function loadStore(stateRoot: string, locationDir: string): Promise<LoadResult> {
  const path = statePath(stateRoot, locationDir)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    // 文件不存在：合法的"新目录"，允许后续写入。
    return { store: emptyStore(locationDir), ok: true }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== 2) {
      return { store: emptyStore(locationDir), ok: false, reason: `状态文件版本非 2（${parsed?.version}），拒绝读写以防覆盖` }
    }
    if (parsed.locationDir !== locationDir) {
      return { store: emptyStore(locationDir), ok: false, reason: "状态文件目录键不匹配，拒绝读写以防覆盖" }
    }
    if (!("task" in parsed) || !Array.isArray(parsed.history)) {
      return { store: emptyStore(locationDir), ok: false, reason: "状态文件结构不完整，拒绝读写以防覆盖" }
    }
    return { store: parsed as Store, ok: true }
  } catch (error) {
    return { store: emptyStore(locationDir), ok: false, reason: `状态文件损坏（${String(error).slice(0, 120)}），拒绝读写以防覆盖` }
  }
}

export async function saveStore(stateRoot: string, store: Store, loadedOk: boolean): Promise<void> {
  if (!loadedOk) {
    throw new Error("loadStore 未成功，禁止写回（防清空守卫）")
  }
  const path = statePath(stateRoot, store.locationDir)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}`
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
  await rename(tmp, path)
}
