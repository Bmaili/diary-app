import { describe, expect, it } from 'vitest'
import { launchTarget } from '../src/core/launch'

describe('桌面快捷方式链接', () => {
  it('认出“写今天”', () => {
    expect(launchTarget('app.diary.local://write/today')).toBe('write-today')
    expect(launchTarget('app.diary.local://write/today/')).toBe('write-today')
    expect(launchTarget('app.diary.local://write/today?x=1')).toBe('write-today')
  })
  it('其他链接不处理', () => {
    expect(launchTarget(undefined)).toBeNull()
    expect(launchTarget('')).toBeNull()
    expect(launchTarget('https://example.com/write/today')).toBeNull()
    expect(launchTarget('app.diary.local://other')).toBeNull()
  })
})
