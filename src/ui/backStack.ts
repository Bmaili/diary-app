/**
 * 安卓返回键先关掉最上层的覆盖层（例如全屏看图），没有覆盖层时才按页面返回（2026-10-12 加入）。
 * 打开覆盖层时 push 一个关闭函数，关掉时调用返回的函数把它移除。
 */
const stack: (() => void)[] = []

export function pushBack(close: () => void): () => void {
  stack.push(close)
  return () => {
    const i = stack.lastIndexOf(close)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** 有覆盖层就关掉最上面的一个并返回 true */
export function popBack(): boolean {
  const close = stack.pop()
  if (!close) return false
  close()
  return true
}
