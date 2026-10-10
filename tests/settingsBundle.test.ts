import { describe, expect, it } from 'vitest'
import { Encrypter } from 'age-encryption'
import { decryptBundle, encryptBundle, looksLikeBundle, settingsFileName, type SettingsBundle } from '../src/core/settingsBundle'
import { LINES, reminderText } from '../src/core/reminder'

const bundle: SettingsBundle = {
  app: 'diary-app',
  kind: 'settings',
  version: 1,
  exportedAt: '2026-10-10T07:00:00.000Z',
  appVersion: '1.0.16',
  parts: {
    ai: { prefs: { profiles: [{ id: 'p1', name: 'DeepSeek' }] }, secrets: { 'llm.p1': 'sk-test' } },
    sync: { prefs: { oss: { enabled: true, bucket: 'b' } }, secrets: { 'oss.secret': 's' }, extra: { keys: { identity: 'AGE-SECRET-KEY-1X', recipient: 'age1x', wrapped: 'AA==' } } },
  },
}

describe('设置导入导出：文件', () => {
  it('用密码加密，再用同一密码解开，内容不变', async () => {
    const bytes = await encryptBundle(bundle, 'correct horse battery', 10)
    expect(looksLikeBundle(bytes)).toBe(true)
    // 密钥不能以明文出现在文件里
    expect(new TextDecoder().decode(bytes)).not.toContain('sk-test')
    const back = await decryptBundle(bytes, 'correct horse battery')
    expect(back.parts.ai).toEqual(bundle.parts.ai)
    expect(back.parts.sync?.extra).toEqual(bundle.parts.sync?.extra)
    expect(back.parts.place).toBeUndefined()
  })

  it('密码错时提示“密码不对”', async () => {
    const bytes = await encryptBundle(bundle, 'correct horse battery', 10)
    await expect(decryptBundle(bytes, 'wrong password!!')).rejects.toThrow('密码不对')
  })

  it('选错文件时提示不是设置文件', async () => {
    const zip = new TextEncoder().encode('PK\u0003\u0004 not a settings file')
    expect(looksLikeBundle(zip)).toBe(false)
    await expect(decryptBundle(zip, 'x')).rejects.toThrow('不是浮生记导出的设置文件')
    // 用 age 加密的别的东西
    const e = new Encrypter()
    e.setPassphrase('pass1234567')
    e.setScryptWorkFactor(10)
    const other = await e.encrypt('{"hello":1}')
    await expect(decryptBundle(other, 'pass1234567')).rejects.toThrow('不是浮生记导出的设置文件')
  })

  it('不认识的类别和格式不对的密钥会被丢掉', async () => {
    const odd = { ...bundle, parts: { ...bundle.parts, lock: { prefs: {}, secrets: { 'lock.pin': '1' } }, place: { prefs: { autoLocate: false }, secrets: { 'amap.key': 1 } } } }
    const back = await decryptBundle(await encryptBundle(odd as unknown as SettingsBundle, 'correct horse battery', 10), 'correct horse battery')
    expect(Object.keys(back.parts).sort()).toEqual(['ai', 'place', 'sync'])
    expect(back.parts.place?.secrets).toEqual({})
  })

  it('文件名带日期', () => {
    expect(settingsFileName(new Date(2026, 9, 10))).toBe('diary-settings-20261010.age')
  })

  it('不设密码不能导出', async () => {
    await expect(encryptBundle(bundle, '')).rejects.toThrow()
  })
})

describe('写日记提醒的句子', () => {
  it('同一天总是同一句，一段时间里各句都会出现', () => {
    expect(reminderText('2026-11-03').body).toBe(reminderText('2026-11-03').body)
    const seen = new Set<string>()
    for (let d = 1; d <= 28; d++) for (const m of ['01', '02', '03', '04', '05', '06']) {
      const body = reminderText(`2027-${m}-${String(d).padStart(2, '0')}`).body
      seen.add(LINES.find((l) => body.endsWith(l))!)
    }
    expect(seen.size).toBe(LINES.length)
    expect(LINES).toContain('浮生如寄，字有归处。')
  })
})
