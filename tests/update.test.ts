import { describe, expect, it } from 'vitest'
import { cleanNotes, formatSize, isNewer, parseRelease, resumeOffset, versionParts } from '../src/core/update'

describe('应用内更新：版本比较', () => {
  it('按数字逐段比较', () => {
    expect(isNewer('1.0.16', '1.0.15')).toBe(true)
    expect(isNewer('1.0.100', '1.0.99')).toBe(true)
    expect(isNewer('1.0.15', '1.0.15')).toBe(false)
    expect(isNewer('1.0.14', '1.0.15')).toBe(false)
    expect(isNewer('1.1', '1.0.99')).toBe(true)
    expect(isNewer('v1.0.16', '1.0.15')).toBe(true)
  })
  it('本地开发版（dev）比任何正式版都旧；格式不对的最新版不算', () => {
    expect(isNewer('1.0.1', 'dev')).toBe(true)
    expect(isNewer('nightly', '1.0.1')).toBe(false)
    expect(versionParts('dev')).toBeNull()
  })
})

describe('应用内更新：解析 Releases 接口', () => {
  const sample = {
    tag_name: 'v1.0.16',
    html_url: 'https://github.com/o/r/releases/tag/v1.0.16',
    published_at: '2026-10-10T08:00:00Z',
    body: '应用内更新：在 app 里下载新版\r\n\r\n- 关于页改了介绍\r\n\r\n---\r\n在手机上下载下面的 APK……',
    assets: [
      { name: 'diary-1.0.16-unsigned.apk', browser_download_url: 'https://x/unsigned.apk', size: 1 },
      { name: 'diary-1.0.16.apk', browser_download_url: 'https://x/diary-1.0.16.apk', size: 13416761, digest: 'sha256:FCF527CDAAADCB4648F59B34EFC453459D591B636663134F681906A7B358BEA6' },
    ],
  }
  it('取版本号、更新内容、签名的安装包和 sha256', () => {
    const r = parseRelease(sample)
    expect(r.version).toBe('1.0.16')
    expect(r.notes).toBe('应用内更新：在 app 里下载新版\n\n- 关于页改了介绍')
    expect(r.apk).toEqual({
      name: 'diary-1.0.16.apk', url: 'https://x/diary-1.0.16.apk', size: 13416761,
      sha256: 'fcf527cdaaadcb4648f59b34efc453459d591b636663134f681906a7b358bea6',
    })
    expect(r.pageUrl).toContain('/releases/tag/v1.0.16')
  })
  it('没有安装包、没有摘要时也能解析', () => {
    expect(parseRelease({ tag_name: 'v1.0.2', assets: [] }).apk).toBeNull()
    expect(parseRelease({ tag_name: 'v1.0.2', assets: [{ name: 'a.apk', browser_download_url: 'https://x/a.apk', size: 5 }] }).apk?.sha256).toBe('')
  })
  it('格式不对时报错', () => {
    expect(() => parseRelease({})).toThrow()
    expect(() => parseRelease({ tag_name: 'latest' })).toThrow(/版本号/)
  })
  it('更新说明去掉安装提示和附注行', () => {
    expect(cleanNotes('标题\nCo-Authored-By: x\n正文')).toBe('标题\n正文')
    expect(cleanNotes('只有一行')).toBe('只有一行')
  })
  it('文件大小', () => {
    expect(formatSize(13416761)).toBe('12.8 MB')
    expect(formatSize(2048)).toBe('2 KB')
  })
})

describe('断点续传：能不能接着上次下', () => {
  const apk = { name: 'diary-1.0.12.apk', url: 'https://x/diary-1.0.12.apk', size: 4_000_000, sha256: 'AbC123' }
  const part = { version: '1.0.12', sha256: 'abc123', size: 4_000_000, bytes: 1_500_000 }
  it('版本、大小、sha256 都一致且没下完：从断点接着下', () => {
    expect(resumeOffset(part, '1.0.12', apk)).toBe(1_500_000)
  })
  it('11 下了一半，12 发布了：从头下', () => {
    expect(resumeOffset({ ...part, version: '1.0.11' }, '1.0.12', apk)).toBe(0)
  })
  it('同一个版本号但安装包变了（sha256 或大小不同）：从头下', () => {
    expect(resumeOffset({ ...part, sha256: 'ffff' }, '1.0.12', apk)).toBe(0)
    expect(resumeOffset({ ...part, size: 3_999_999 }, '1.0.12', apk)).toBe(0)
  })
  it('没有 sha256 认不准；没有半截文件、已经下完、记录坏了：都从头下', () => {
    expect(resumeOffset(part, '1.0.12', { ...apk, sha256: '' })).toBe(0)
    expect(resumeOffset({ ...part, sha256: '' }, '1.0.12', apk)).toBe(0)
    expect(resumeOffset(null, '1.0.12', apk)).toBe(0)
    expect(resumeOffset({}, '1.0.12', apk)).toBe(0)
    expect(resumeOffset({ ...part, bytes: 4_000_000 }, '1.0.12', apk)).toBe(0)
    expect(resumeOffset({ ...part, bytes: 0 }, '1.0.12', apk)).toBe(0)
    expect(resumeOffset(part, '1.0.12', null)).toBe(0)
  })
})
