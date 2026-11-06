/** 服务端独立执行验收命令：可信代码执行，结果记入任务状态，不采信模型自述。 */
import { exec } from "node:child_process"
import type { CheckResult, Task } from "./machine"

const TAIL = 2000

/** A5：顺序执行（计划里的命令可能有依赖，如 make → make test）；
 * exitCode 归一为数字（ENOENT 等字符串错误码归 127，被杀归 124）。 */
export async function runChecks(
  cwd: string,
  task: Task,
  timeoutSeconds: number,
): Promise<{ checks: CheckResult[] }> {
  const commands = task.plan?.testCommands ?? []
  const checks: CheckResult[] = []
  for (const command of commands) {
    checks.push(await runOne(cwd, command, timeoutSeconds))
  }
  return { checks }
}

function runOne(cwd: string, command: string, timeoutSeconds: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    exec(
      command,
      { cwd, timeout: timeoutSeconds * 1000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "")
        const errOut = String(stderr ?? "")
        let exitCode = 0
        let timedOut = false
        if (error) {
          if ((error as { killed?: boolean }).killed) {
            timedOut = true
            exitCode = 124
          } else if (typeof error.code === "number") {
            exitCode = error.code
          } else {
            exitCode = 127
          }
        }
        resolve({
          command,
          exitCode,
          timedOut,
          durationMs: Date.now() - started,
          stdoutTail: out.slice(-TAIL),
          stderrTail: errOut.slice(-TAIL),
        })
      },
    )
  })
}
