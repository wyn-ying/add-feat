import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { safeDocPath } from "./docpaths"

/** 不向项目增加过程文件；保留原始字节和来源，成功备份后调用方才可覆盖。 */
export async function archiveDelivery(root: string, repository: string, path: string, expectedHash: string): Promise<string> {
  if (!safeDocPath(path)) throw new Error("非法 delivery 路径")
  const bytes = await readFile(join(repository, path))
  const hash = createHash("sha256").update(bytes).digest("hex")
  if (hash !== expectedHash) throw new Error("备份前旧正文哈希已变化，拒绝覆盖")
  const dir = join(root, "delivery-revisions")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const archive = join(dir, `${Date.now()}-${randomUUID()}.json`)
  await writeFile(archive, JSON.stringify({ repository, path, hash, at: new Date().toISOString(), contentBase64: bytes.toString("base64") }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  return archive
}
