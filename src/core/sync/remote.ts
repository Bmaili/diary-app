import { http, NetworkError, type HttpRequest, type HttpResponse } from '../http'

/** 云端存储的统一接口。路径一律相对于 diary/，例如 entries/2026/2026-10-04.md。 */

export interface RemoteFile {
  path: string
  size: number
  /** 内容的指纹（GitHub 的 blob sha、OSS 的 ETag）：恢复中断后再来，指纹没变的不用重下 */
  etag?: string
}

/**
 * 要上传的一个文件（2026-10-19 起按需读取）：以前先把所有要传的文件读进内存再上传，
 * 第一次同步、开关加密全部重传时照片一多就会内存不足闪退。现在上传到哪个读哪个。
 */
export interface Upload {
  /** 云端路径（加密时带 .age） */
  path: string
  /** 本地文件的大小（估算分批用，加密后会大一点） */
  size: number
  /** 读出要上传的内容（加密时是密文）；文件在这期间被删了返回 null，跳过它 */
  read(): Promise<Uint8Array | null>
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
   * 上传与删除。OSS 逐个文件进行，每完成一个就回调；GitHub 分批打成 commit（每批最多 100 个文件或 20 MB），
   * 每批提交成功后回调这一批，中途失败的话已提交的批次不用重传。
   */
  apply(uploads: Upload[], deletes: string[], onDone: (path: string, kind: 'upload' | 'delete') => Promise<void>): Promise<void>
  /** 下载一个文件，不存在时返回 null */
  get(path: string): Promise<Uint8Array | null>
  /**
   * 下载全部文件（恢复用）：一个一个下，下好一个回调一个，内存里只放正在下的那个。
   * skip(path, etag) 返回 true 的不下（上次恢复中断前已经下好的）。
   */
  downloadAll(
    onFile: (path: string, bytes: Uint8Array, etag?: string) => Promise<void>,
    onProgress?: (done: number, total: number) => void,
    skip?: (path: string, etag?: string) => boolean,
  ): Promise<number>
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
