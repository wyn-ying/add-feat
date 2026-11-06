import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ROLES,
  agentPath,
  agentsDir,
  listModels,
  parseFrontmatter,
  readOverrides,
  replaceModelLine,
  setModel,
  showModels,
  unsetModel,
  validateModelId,
} from "../add-feat-model.mjs"

async function makeHome(): Promise<string> {
  await mkdir(tmpdir(), { recursive: true })
  const home = await mkdtemp(join(tmpdir(), "addfeat-model-"))
  const agents = join(home, ".config/opencode/agents")
  await mkdir(agents, { recursive: true })
  const factory: Record<string, string> = {
    "add-feat.md": "openai/gpt-6.1-sol",
    "add-feat-developer.md": "zhipuai-coding-plan/glm-5.3",
    "add-feat-auditor.md": "openai/gpt-6.1-terra",
    "add-feat-fixer.md": "zhipuai-coding-plan/glm-5.3",
    "add-feat-fixer-flash.md": "zhipuai-coding-plan/glm-5.3-flash",
  }
  for (const [file, model] of Object.entries(factory)) {
    await writeFile(
      join(agents, file),
      `---\ndescription: ${file} 含 model 字样的描述文字\nmode: subagent\nmodel: ${model}\npermissions:\n  - action: edit\n    resource: "*"\n    effect: deny\n---\n\n正文提到 model: fake 但不应被改动。\n`,
    )
  }
  return home
}

const CATALOG = [
  "a/one",
  "a/two",
  "a/tmp",
  "coding-plan/kimi-k2.7-code",
  "opencode/glm-5.3-flash-free",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-terra",
  "volcengine-coding-plan/glm-5.3",
  "zhipuai-coding-plan/glm-5.3",
  "zhipuai-coding-plan/glm-5.3-flash",
].join("\n") + "\n"

function fakeRun(stdout: string) {
  return (async () => stdout) as unknown as () => Promise<string>
}

describe("角色与路径映射", () => {
  test("6 个角色全支持，文件名固定", () => {
    expect(Object.keys(ROLES).sort()).toEqual(
      ["auditor", "coordinator", "developer", "fixer", "fixer-flash"].sort(),
    )
    expect(agentPath("developer")).toBe("add-feat-developer.md")
    expect(agentPath("coordinator")).toBe("add-feat.md")
  })
})

describe("frontmatter 解析与替换", () => {
  test("只定位 frontmatter 内的 model 行，正文中的 model: 不受影响", () => {
    const content = `---\nmode: subagent\nmodel: a/old\n---\n\n正文 model: fake\n`
    const parsed = parseFrontmatter(content)
    expect(parsed.model).toBe("a/old")
    const next = replaceModelLine(content, "b/new")
    expect(next).toContain("model: b/new")
    expect(next).toContain("正文 model: fake")
    expect(next.match(/^model:/gm)!.length).toBe(1)
  })
  test("无 model 行返回 null，替换拒绝", () => {
    expect(parseFrontmatter("---\nmode: subagent\n---\n").model).toBeNull()
    expect(() => replaceModelLine("---\nmode: subagent\n---\n", "a/b")).toThrow(/model/)
  })
  test("CRLF 行尾保持不变", () => {
    const content = "---\r\nmode: subagent\r\nmodel: a/old\r\n---\r\n"
    expect(replaceModelLine(content, "a/new")).toContain("model: a/new\r\n")
  })
})

describe("清单与校验", () => {
  test("listModels 解析 opencode models 输出，忽略空行", async () => {
    const models = await listModels(fakeRun(CATALOG))
    expect(models.length).toBe(10)
    expect(models).toContain("zhipuai-coding-plan/glm-5.3-flash")
  })
  test("输出不可解析时报错而非放行", async () => {
    await expect(listModels(fakeRun(""))).rejects.toThrow(/models/)
  })
  test("合法 ID 通过，非法 ID 拒绝并给模糊候选", async () => {
    const models = await listModels(fakeRun(CATALOG))
    expect(validateModelId("zhipuai-coding-plan/glm-5.3-flash", models)).toBe(true)
    let caught
    try {
      validateModelId("zhipu-coding-plan/glm-5.3-flash", models)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect(String(caught.suggestions)).toContain("zhipuai-coding-plan/glm-5.3-flash")
  })
  test("--force 跳过校验", async () => {
    const models = await listModels(fakeRun(CATALOG))
    expect(validateModelId("totally/fake", models, true)).toBe(true)
  })
})

describe("set / unset / show", () => {
  test("set 替换模型并记录出厂值，frontmatter 外零改动", async () => {
    const home = await makeHome()
    try {
      const before = await readFile(join(agentsDir(home), agentPath("developer")), "utf8")
      const r = await setModel("developer", "zhipuai-coding-plan/glm-5.3-flash", { home, catalog: CATALOG })
      expect(r.from).toBe("zhipuai-coding-plan/glm-5.3")
      const after = await readFile(join(agentsDir(home), agentPath("developer")), "utf8")
      expect(after).toContain("model: zhipuai-coding-plan/glm-5.3-flash")
      expect(after.endsWith("\n")).toBe(before.endsWith("\n"))
      const ov = await readOverrides(home)
      expect(ov.developer.original).toBe("zhipuai-coding-plan/glm-5.3")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("重复 set 保留最初的出厂值", async () => {
    const home = await makeHome()
    try {
      await setModel("developer", "a/one", { home, catalog: CATALOG })
      await setModel("developer", "a/two", { home, catalog: CATALOG })
      const ov = await readOverrides(home)
      expect(ov.developer.original).toBe("zhipuai-coding-plan/glm-5.3")
      expect(ov.developer.current).toBe("a/two")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("非法 ID 拒绝且文件零改动", async () => {
    const home = await makeHome()
    try {
      const before = await readFile(join(agentsDir(home), agentPath("auditor")), "utf8")
      await expect(setModel("auditor", "no/such", { home, catalog: CATALOG })).rejects.toThrow(/不在当前可用清单/)
      expect(await readFile(join(agentsDir(home), agentPath("auditor")), "utf8")).toBe(before)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("unset 还原出厂模型并清掉覆盖记录", async () => {
    const home = await makeHome()
    try {
      await setModel("fixer", "a/tmp", { home, catalog: CATALOG })
      const r = await unsetModel("fixer", { home })
      expect(r.restored).toBe("zhipuai-coding-plan/glm-5.3")
      expect(await readFile(join(agentsDir(home), agentPath("fixer")), "utf8")).toContain("model: zhipuai-coding-plan/glm-5.3\n")
      const ov = await readOverrides(home)
      expect(ov.fixer).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("未覆盖过的角色 unset 报错", async () => {
    const home = await makeHome()
    try {
      await expect(unsetModel("coordinator", { home })).rejects.toThrow(/出厂/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("show 列出全部角色并标注覆盖与失效", async () => {
    const home = await makeHome()
    try {
      await setModel("developer", "zhipuai-coding-plan/glm-5.3-flash", { home, catalog: CATALOG })
      await setModel("auditor", "totally/gone", { home, catalog: CATALOG, force: true })
      const rows = await showModels({ home, catalog: CATALOG })
      const dev = rows.find((r: any) => r.role === "developer")
      const aud = rows.find((r: any) => r.role === "auditor")
      const coord = rows.find((r: any) => r.role === "coordinator")
      expect(dev.overridden).toBe(true)
      expect(aud.overridden).toBe(true)
      expect(aud.available).toBe(false)
      expect(coord.overridden).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("agent 文件缺失时报清晰错误", async () => {
    const home = await makeHome()
    try {
      await rm(join(agentsDir(home), agentPath("auditor")))
      await expect(setModel("auditor", "openai/gpt-6.1-terra", { home, catalog: CATALOG })).rejects.toThrow(/未找到|agents/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
