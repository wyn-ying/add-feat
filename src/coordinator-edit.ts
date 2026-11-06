import type { Phase } from "./workflow"

export function coordinatorEditAllowed(phase?: Phase): boolean {
  return phase !== "dev_running" && phase !== "audit_running" && phase !== "fix_running"
}
