import { describe, expect, test } from "bun:test"
import { coordinatorEditAllowed } from "../src/coordinator-edit"

describe("协调者编辑权限", () => {
  test("仅子代理执行期间禁止协调者编辑", () => {
    for (const phase of ["dev_running", "audit_running", "fix_running"] as const) {
      expect(coordinatorEditAllowed(phase)).toBe(false)
    }
    for (const phase of [undefined, "planning", "dev_ready", "audit_ready", "accept_ready", "fix_ready", "accepted", "exhausted", "blocked_human", "tampered", "cancelled"] as const) {
      expect(coordinatorEditAllowed(phase)).toBe(true)
    }
  })
})
