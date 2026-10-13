// 端到端测试用：app 自己的提示框（ui/dialog.ts）出来时自动点主按钮，相当于以前对系统弹窗的 accept()。
// 测试里可以改规则：window.__dialogRule = { input: '杰哥', pick: { when: '云端已有', label: '直接开启同步' } }
// 要截提示框的图时设 window.__noAutoDialog = true。弹过的提示框文字记在 window.__dialogLog。
export function autoDialog() {
  window.__dialogLog = []
  let last = null
  const run = () => {
    const d = document.querySelector('.dlg')
    if (!d) {
      last = null
      return
    }
    const text = d.textContent || ''
    if (text === last || window.__noAutoDialog) return
    last = text
    window.__dialogLog.push(text)
    const rule = window.__dialogRule || {}
    setTimeout(() => {
      const input = d.querySelector('input')
      if (input && rule.input != null) {
        input.value = rule.input
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const buttons = [...d.querySelectorAll('.dlg-btn')]
      let btn = rule.pick && text.includes(rule.pick.when) ? buttons.find((b) => b.textContent.trim() === rule.pick.label) : null
      btn = btn || d.querySelector('.dlg-btn:not(.ghost)')
      if (btn) btn.click()
    }, 60)
  }
  new MutationObserver(run).observe(document, { childList: true, subtree: true, characterData: true })
}
