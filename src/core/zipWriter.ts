/**
 * 边写边出的 zip（2026-10-08 起用于导出）。一次只处理一个文件，写完就交给 sink，
 * 内存里只留每个文件在中央目录里的几十字节，不会把全部日记和图片同时读进内存。
 *
 * - 图片本来就是压缩过的 JPEG，原样存（STORE）；文字用 deflate-raw 压缩（浏览器 / WebView 自带的
 *   CompressionStream），不支持时也原样存。
 * - 文件名用 UTF-8（通用标志位第 11 位）。
 * - 不支持 zip64：单个文件或整个包超过 4 GB、或超过 65535 个文件时报错（日记远到不了）。
 */

export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>
}

interface CentralEntry {
  name: Uint8Array
  crc: number
  method: number
  compSize: number
  size: number
  offset: number
  time: number
  date: number
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** zip 里的时间是 DOS 格式（本地时间，2 秒精度，最早 1980 年） */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const cs = new CompressionStream('deflate-raw')
    const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(cs))
    return new Uint8Array(await out.arrayBuffer())
  } catch {
    return null
  }
}

const LIMIT = 0xffffffff

export class ZipWriter {
  private offset = 0
  private entries: CentralEntry[] = []
  private enc = new TextEncoder()

  constructor(private sink: ByteSink) {}

  private async put(chunk: Uint8Array) {
    await this.sink.write(chunk)
    this.offset += chunk.length
    if (this.offset > LIMIT) throw new Error('导出的文件超过 4 GB，暂不支持')
  }

  /** 加一个文件。compress：是否尝试压缩（文字压，图片不压） */
  async add(name: string, data: Uint8Array, opts: { compress?: boolean; mtime?: Date } = {}): Promise<void> {
    if (this.entries.length >= 0xffff) throw new Error('文件数超过 65535，暂不支持')
    const nameBytes = this.enc.encode(name)
    const crc = crc32(data)
    let body = data
    let method = 0
    if (opts.compress && data.length > 64) {
      const z = await deflateRaw(data)
      if (z && z.length < data.length) {
        body = z
        method = 8
      }
    }
    const { time, date } = dosTime(opts.mtime ?? new Date())
    const h = new DataView(new ArrayBuffer(30))
    h.setUint32(0, 0x04034b50, true)
    h.setUint16(4, 20, true) // 解压需要的版本 2.0
    h.setUint16(6, 0x0800, true) // 文件名是 UTF-8
    h.setUint16(8, method, true)
    h.setUint16(10, time, true)
    h.setUint16(12, date, true)
    h.setUint32(14, crc, true)
    h.setUint32(18, body.length, true)
    h.setUint32(22, data.length, true)
    h.setUint16(26, nameBytes.length, true)
    h.setUint16(28, 0, true)
    const offset = this.offset
    await this.put(new Uint8Array(h.buffer))
    await this.put(nameBytes)
    await this.put(body)
    this.entries.push({ name: nameBytes, crc, method, compSize: body.length, size: data.length, offset, time, date })
  }

  /** 写中央目录和结尾记录。返回文件数和 zip 总字节数 */
  async finish(): Promise<{ files: number; bytes: number }> {
    const cdStart = this.offset
    for (const e of this.entries) {
      const h = new DataView(new ArrayBuffer(46))
      h.setUint32(0, 0x02014b50, true)
      h.setUint16(4, 20, true)
      h.setUint16(6, 20, true)
      h.setUint16(8, 0x0800, true)
      h.setUint16(10, e.method, true)
      h.setUint16(12, e.time, true)
      h.setUint16(14, e.date, true)
      h.setUint32(16, e.crc, true)
      h.setUint32(20, e.compSize, true)
      h.setUint32(24, e.size, true)
      h.setUint16(28, e.name.length, true)
      // 30 扩展字段长度、32 注释长度、34 磁盘号、36 内部属性、38 外部属性：都是 0
      h.setUint32(42, e.offset, true)
      await this.put(new Uint8Array(h.buffer))
      await this.put(e.name)
    }
    const cdSize = this.offset - cdStart
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, this.entries.length, true)
    end.setUint16(10, this.entries.length, true)
    end.setUint32(12, cdSize, true)
    end.setUint32(16, cdStart, true)
    await this.put(new Uint8Array(end.buffer))
    return { files: this.entries.length, bytes: this.offset }
  }
}

/** 测试和浏览器下载用：把写出的块收集起来 */
export class MemorySink implements ByteSink {
  chunks: Uint8Array[] = []
  async write(chunk: Uint8Array) {
    this.chunks.push(chunk.slice())
  }
  bytes(): Uint8Array {
    const n = this.chunks.reduce((a, c) => a + c.length, 0)
    const out = new Uint8Array(n)
    let o = 0
    for (const c of this.chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  }
}
