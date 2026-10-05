/**
 * v-reveal：元素第一次滚进屏幕时浮上来一次，之后就是普通元素（2026-10-05 起替换滚动驱动动画）。
 * 原来每一条日记都挂着跟随滚动的动画，几百条同时处于“动画中”，浏览器要给每条单独建图层，
 * 中低端手机上滚动会卡、不跟手。现在动画只在进场时跑一次，跑完就摘掉。
 */
import type { Directive } from 'vue'
import { motionOn } from './motion'

let io: IntersectionObserver | null = null

function observer(): IntersectionObserver {
  io ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const el = e.target as HTMLElement
        io!.unobserve(el)
        el.classList.remove('reveal-wait')
        el.classList.add('reveal-in')
        el.addEventListener('animationend', () => el.classList.remove('reveal-in'), { once: true })
      }
    },
    { rootMargin: '0px 0px -24px 0px' },
  )
  return io
}

export const vReveal: Directive<HTMLElement> = {
  mounted(el) {
    if (!motionOn() || typeof IntersectionObserver === 'undefined') return
    // 已经在屏幕里的（首屏）直接浮现，屏幕外的等滚到再浮现
    el.classList.add('reveal-wait')
    observer().observe(el)
  },
  unmounted(el) {
    io?.unobserve(el)
  },
}
