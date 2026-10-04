import { http, NetworkError, type HttpRequest, type HttpResponse } from '../http'

/** 云端存储的统一接口。路径一律相对于 diary/，例如 entries/2026/2026-10-04.md。 */

export interface RemoteFile {
  path: string
  size: number
}

export interface Upload {
  path: string
  bytes: Uint8Array
  /** 本地内容的 sha256，成功后写入清单 */
  hash: string
}

export interface ApplyResult {
  uploaded: string[]
  deleted: string[]
}

export interface RemoteStore {
  readonly id: 'oss' | 'github'
  readonly label: string
  /** 列出云端全部文件 */
  list(): Promise<RemoteFile[]>
  /**
   * 上传与删除。OSS 逐个文件进行，每完成一个就回调；GitHub 打成一个 commit，全部成功后统一回调。
   */
  apply(uploads: Upload[], deletes: string[], onDone: (path: string, kind: 'upload' | 'delete') => Promise<void>): Promise<void>
  /** 下载一个文件，不存在时返回 null */
  get(path: string): Promise<Uint8Array | null>
  /** 下载全部文件（恢复用），逐个回调 */
  downloadAll(onFile: (path: string, bytes: Uint8Array) => Promise<void>, onProgress?: (done: number, total: number) => void): Promise<number>
  /** 写入并删除一个临时文件，验证配置 */
  test(): Promise<void>
}

export class RemoteError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = true) {
    super(message)
  }
}

export const contentTypeOf = (path: string): string => {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'md': return 'text/markdown; charset=utf-8'
    case 'json': return 'application/json; charset=utf-8'
    case 'txt': return 'text/plain; charset=utf-8'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return 'application/octet-stream'
  }
}

/** 发请求；网络错误统一转成可重试的 RemoteError */
export async function call(req: HttpRequest): Promise<HttpResponse> {
  try {
    return await http(req)
  } catch (e) {
    if (e instanceof NetworkError) throw new RemoteError(e.message)
    throw e
  }
}

/** 有限并发地处理一组任务 */
export async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  let failed: unknown = null
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++
      try {
        await fn(items[i], i)
      } catch (e) {
        failed ??= e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  if (failed) throw failed
}
