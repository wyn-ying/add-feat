import { describe, test, expect } from "bun:test"
// 端到端：仓库版 add-feat-model.mjs 在假 HOME 下 set/unset（catalog 注入走单元测试已覆盖，
// 这里验证真实文件写入行为与覆盖记录格式）
import { setModel, unsetModel, readOverrides, showModels } from "../add-feat-model.mjs"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("仓库版 CLI e2e", () => {
  test("set→override→unset 全链路", async () => {
    const home = await mkdtemp(join(tmpdir(), "addfeat-e2e-"))
    try {
      await mkdir(join(home, ".config/opencode/agents"), { recursive: true })
      await writeFile(
        join(home, ".config/opencode/agents/add-feat-developer.md"),
        "---\ndescription: d\nmode: subagent\nmodel: zhipuai-coding-plan/glm-5.3\n---\n",
      )
      const cat = ["zhipuai-coding-plan/glm-5.3", "zhipuai-coding-plan/glm-5.3-flash"].join("\n") + "\n"
      const r1 = await setModel("developer", "zhipuai-coding-plan/glm-5.3-flash", { home, catalog: cat })
      expect(r1.changed).toBe(true)
      const r2 = await setModel("developer", "zhipuai-coding-plan/glm-5.3-flash", { home, catalog: cat })
      expect(r2.changed).toBe(false)
      const ov = await readOverrides(home)
      expect(ov.developer.original).toBe("zhipuai-coding-plan/glm-5.3")
      const u = await unsetModel("developer", { home })
      expect(u.restored).toBe("zhipuai-coding-plan/glm-5.3")
      const after = await readFile(join(home, ".config/opencode/agents/add-feat-developer.md"), "utf8")
      expect(after).toContain("model: zhipuai-coding-plan/glm-5.3\n")
      const rows = await showModels({ home, catalog: cat })
      expect(rows.find((r) => r.role === "developer")!.overridden).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
