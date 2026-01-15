/*
  移动端 UI 交互逻辑
  - 文件库面板交互补丁（避免误触）
  - 虚拟键盘适配
*/

import { isMobile } from './platform'
import { isCommandPaletteOpen, openCommandPalette } from './ui/commandPalette'

let _autoCloseBindTries = 0
let _pullDownPaletteBound = false

// 初始化移动端 UI
export function initMobileUI(): void {
  if (!isMobile()) return

  // 适配虚拟键盘
  adaptVirtualKeyboard()

  // 禁用桌面端拖拽打开文件
  disableDragDrop()

  // 点击文件后自动收起库面板（仅文件，不关闭目录）
  bindAutoCloseLibraryOnFileClick()

  // 下滑呼出命令面板（类似“下拉刷新”：仅在内容已到顶时触发）
  bindPullDownCommandPalette()
}

function hideLibraryPanel(): void {
  try {
    const lib = document.getElementById('library') as HTMLDivElement | null
    if (!lib || lib.classList.contains('hidden')) return
    const btn = document.getElementById('btn-library') as HTMLDivElement | null
    if (btn) {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return
    }
    lib.classList.add('hidden')
  } catch {}
}

// 计算“键盘遮挡底部高度”（VisualViewport 存在时相对可靠）
function getKeyboardInsetBottomPx(): number {
  try {
    const vv = (window as any).visualViewport as VisualViewport | undefined
    if (!vv) return 0
    const inset = window.innerHeight - (vv.height + vv.offsetTop)
    if (!Number.isFinite(inset)) return 0
    return Math.max(0, Math.round(inset))
  } catch {
    return 0
  }
}

let _taCaretMirror: HTMLDivElement | null = null
let _taCaretMirrorSpan: HTMLSpanElement | null = null

// 获取 textarea 光标位置的像素坐标（相对“内容顶部”，不含 paddingTop）
function getTextareaCaretMetricsPx(ta: HTMLTextAreaElement, pos: number): { top: number; height: number } | null {
  try {
    const style = window.getComputedStyle(ta)
    const val = String(ta.value || '')
    const p = Math.max(0, Math.min(pos >>> 0, val.length))

    if (!_taCaretMirror) {
      _taCaretMirror = document.createElement('div')
      _taCaretMirror.style.position = 'absolute'
      _taCaretMirror.style.left = '-99999px'
      _taCaretMirror.style.top = '0'
      _taCaretMirror.style.visibility = 'hidden'
      _taCaretMirror.style.pointerEvents = 'none'
      _taCaretMirror.style.whiteSpace = 'pre-wrap'
      _taCaretMirror.style.wordWrap = 'break-word'
      ;(_taCaretMirror.style as any).overflowWrap = 'break-word'
      _taCaretMirror.style.overflow = 'hidden'
      document.body.appendChild(_taCaretMirror)
    }
    if (!_taCaretMirrorSpan) _taCaretMirrorSpan = document.createElement('span')

    // 复制必要样式以匹配换行/折行行为（别玩花活，最小集合就够）
    const m = _taCaretMirror
    m.style.boxSizing = style.boxSizing
    m.style.width = ta.offsetWidth + 'px'
    m.style.fontFamily = style.fontFamily
    m.style.fontSize = style.fontSize
    m.style.fontWeight = style.fontWeight
    m.style.fontStyle = style.fontStyle
    m.style.letterSpacing = style.letterSpacing
    m.style.textTransform = style.textTransform
    m.style.lineHeight = style.lineHeight
    m.style.paddingTop = style.paddingTop
    m.style.paddingRight = style.paddingRight
    m.style.paddingBottom = style.paddingBottom
    m.style.paddingLeft = style.paddingLeft
    m.style.borderTopWidth = style.borderTopWidth
    m.style.borderRightWidth = style.borderRightWidth
    m.style.borderBottomWidth = style.borderBottomWidth
    m.style.borderLeftWidth = style.borderLeftWidth
    m.style.borderStyle = style.borderStyle
    m.style.tabSize = (style as any).tabSize || '8'
    ;(m.style as any).MozTabSize = (style as any).MozTabSize || (style as any).tabSize || '8'

    // 用 TextNode + marker span，避免 innerHTML 带来的转义/性能问题
    while (m.firstChild) m.removeChild(m.firstChild)
    m.appendChild(document.createTextNode(val.slice(0, p)))
    _taCaretMirrorSpan.textContent = '\u200b'
    m.appendChild(_taCaretMirrorSpan)

    const padTop = parseFloat(style.paddingTop) || 0
    const top = (_taCaretMirrorSpan.offsetTop || 0) - padTop
    const lh = parseFloat(style.lineHeight) || _taCaretMirrorSpan.offsetHeight || 16
    return { top, height: lh }
  } catch {
    return null
  }
}

// 键盘弹出时，把光标行兜底滚到可视区（偏中间），避免“最后几行被键盘盖住无法编辑”
function ensureEditorCaretVisible(kbInset: number): void {
  try {
    if (!kbInset || kbInset < 80) return

    const active = (document.activeElement as HTMLElement | null)

    // 源码模式：textarea
    const ta = document.getElementById('editor') as HTMLTextAreaElement | null
    if (ta && active === ta) {
      const m = getTextareaCaretMetricsPx(ta, ta.selectionEnd >>> 0)
      if (!m) return

      const style = window.getComputedStyle(ta)
      const padTop = parseFloat(style.paddingTop) || 0
      const padBottom = parseFloat(style.paddingBottom) || 0
      const visibleH = Math.max(0, ta.clientHeight - padTop - padBottom - kbInset)
      if (visibleH <= 0) return

      const y = m.top - (ta.scrollTop || 0)
      const margin = 14
      const needUp = y < margin
      const needDown = (y + m.height) > (visibleH - margin)
      if (!needUp && !needDown) return

      // “把光标行滑到屏幕中间”：简单粗暴但可预期
      const target = Math.max(0, m.top - Math.floor(visibleH * 0.5))
      if (Number.isFinite(target)) ta.scrollTop = target
      return
    }

    // 所见即所得：ProseMirror / contenteditable（尽量不侵入，只在遮挡时矫正）
    const wysiRoot = document.getElementById('md-wysiwyg-root') as HTMLElement | null
    if (wysiRoot && active && (active === wysiRoot || active.closest?.('#md-wysiwyg-root'))) {
      const scrollEl = (document.querySelector('#md-wysiwyg-root .scrollView') as HTMLElement | null) || wysiRoot
      const sel = window.getSelection()
      if (!sel || sel.rangeCount <= 0) return

      const r0 = sel.getRangeAt(0).cloneRange()
      r0.collapse(true)
      const rect = r0.getBoundingClientRect()
      if (!rect || (!rect.height && !rect.width)) return

      const host = scrollEl.getBoundingClientRect()
      const visibleH = Math.max(0, scrollEl.clientHeight - kbInset)
      if (visibleH <= 0) return

      const caretY = (rect.top - host.top) + (scrollEl.scrollTop || 0)
      const y = caretY - (scrollEl.scrollTop || 0)
      const margin = 14
      const needUp = y < margin
      const needDown = (y + Math.max(16, rect.height || 0)) > (visibleH - margin)
      if (!needUp && !needDown) return

      const target = Math.max(0, caretY - Math.floor(visibleH * 0.5))
      if (Number.isFinite(target)) scrollEl.scrollTop = target
    }
  } catch {}
}

// 适配虚拟键盘（防止遮挡编辑器）
function adaptVirtualKeyboard(): void {
  // 使用 Visual Viewport API
  if ('visualViewport' in window) {
    const viewport = window.visualViewport!

    let raf = 0
    const scheduleEnsure = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        try { ensureEditorCaretVisible(getKeyboardInsetBottomPx()) } catch {}
      })
    }

    const update = () => {
      const editor = document.getElementById('editor') as HTMLTextAreaElement | null
      if (!editor) return

      const kbInset = getKeyboardInsetBottomPx()
      if (kbInset > 80) {
        // 给底部留出可滚动空间；真正的“上顶/居中”交给 ensureEditorCaretVisible() 做兜底
        editor.style.paddingBottom = `${kbInset}px`
      } else {
        editor.style.paddingBottom = '0'
      }
      scheduleEnsure()
    }

    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    window.addEventListener('resize', update)

    // 某些输入法/ROM 不触发 resize，focus/selectionchange 还能救回来一部分
    document.addEventListener('focusin', () => { try { update() } catch {} }, true)
    document.addEventListener('selectionchange', () => { try { scheduleEnsure() } catch {} }, true)

    // 初始化一次
    update()
  }
}

// 禁用拖拽打开文件（移动端不支持）
function disableDragDrop(): void {
  document.addEventListener('dragover', (e) => e.preventDefault(), true)
  document.addEventListener('drop', (e) => e.preventDefault(), true)
}

function bindAutoCloseLibraryOnFileClick(): void {
  try {
    const lib = document.getElementById('library')
    if (!lib) {
      // main.ts 会在模块加载后续步骤里创建 #library，这里做一个温和的重试即可
      if (_autoCloseBindTries++ < 20) {
        window.setTimeout(() => {
          try { bindAutoCloseLibraryOnFileClick() } catch {}
        }, 80)
      }
      return
    }
    if ((lib as any)._mobileAutoCloseBound) return
    ;(lib as any)._mobileAutoCloseBound = true

    lib.addEventListener(
      'click',
      (ev) => {
        try {
          const target = ev.target as HTMLElement | null
          const fileNode = target?.closest?.('.lib-node.lib-file') as HTMLElement | null
          if (!fileNode) return
          // 给打开/渲染留一点时间，避免偶发“点击无效”的错觉
          window.setTimeout(() => {
            try { hideLibraryPanel() } catch {}
          }, 60)
        } catch {}
      },
      { capture: true },
    )
  } catch {}
}

function bindPullDownCommandPalette(): void {
  try {
    if (_pullDownPaletteBound) return
    _pullDownPaletteBound = true

    const START_ZONE_BELOW_TITLEBAR_PX = 26
    let tracking = false
    let startX = 0
    let startY = 0
    let startedAt = 0
    let startTarget: EventTarget | null = null
    let startZone: 'titlebar' | 'below' | null = null
    let lastOpenAt = 0

    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      try {
        const el = target as HTMLElement | null
        if (!el) return false
        if (el.closest('button, a, input, textarea, select, [contenteditable=\"true\"], .menu-item, .menubar')) return true
        return false
      } catch {
        return false
      }
    }

    const getTitlebarRect = (): DOMRect | null => {
      try {
        const t = document.querySelector('.titlebar') as HTMLElement | null
        if (!t) return null
        return t.getBoundingClientRect()
      } catch {
        return null
      }
    }

    const isScrollAtTop = (target: EventTarget | null): boolean => {
      try {
        const el = target as HTMLElement | null
        const editor = document.getElementById('editor') as any
        if (editor && el && (el === editor || el.closest?.('#editor'))) {
          return (Number(editor.scrollTop) || 0) <= 0
        }
      } catch {}
      try {
        const el = target as HTMLElement | null
        const preview = document.querySelector('.preview') as any
        if (preview && el && (el === preview || el.closest?.('.preview'))) {
          return (Number(preview.scrollTop) || 0) <= 0
        }
      } catch {}
      try {
        const el = target as HTMLElement | null
        const root = document.getElementById('md-wysiwyg-root') as any
        if (root && el && (el === root || el.closest?.('#md-wysiwyg-root'))) {
          return (Number(root.scrollTop) || 0) <= 0
        }
      } catch {}
      try {
        const se = document.scrollingElement as any
        return (Number(se?.scrollTop) || 0) <= 0
      } catch {
        return true
      }
    }

    document.addEventListener('touchstart', (ev: TouchEvent) => {
      try {
        if (!isMobile()) return
        if (isCommandPaletteOpen()) return
        if (ev.touches?.length !== 1) return
        if (isInteractiveTarget(ev.target)) return

        const t = ev.touches[0]
        const y = t?.clientY ?? 0
        const rect = getTitlebarRect()
        const titlebarTop = rect?.top ?? 0
        const titlebarBottom = rect?.bottom ?? 0
        const titlebarEl = (ev.target as HTMLElement | null)?.closest?.('.titlebar') as HTMLElement | null

        // 仅允许从“标题栏”或“标题栏下方一小段区域”开始下滑，避免和内容滚动抢手势
        if (y < titlebarTop) return
        if (y <= titlebarBottom) {
          if (!titlebarEl) return
          startZone = 'titlebar'
        } else {
          if (y > titlebarBottom + START_ZONE_BELOW_TITLEBAR_PX) return
          startZone = 'below'
        }

        tracking = true
        startedAt = Date.now()
        startX = t?.clientX ?? 0
        startY = y
        startTarget = ev.target
      } catch {}
    }, { capture: true, passive: true })

    document.addEventListener('touchend', (ev: TouchEvent) => {
      try {
        if (!tracking) return
        tracking = false
        if (!isMobile()) return
        if (isCommandPaletteOpen()) return
        if (ev.changedTouches?.length !== 1) return

        // 从“标题栏下方区域”触发时，必须确保内容已滚动到顶；否则就是在破坏正常滚动
        if (startZone !== 'titlebar') {
          if (!isScrollAtTop(startTarget)) return
        }

        const t = ev.changedTouches[0]
        const endX = t?.clientX ?? 0
        const endY = t?.clientY ?? 0
        const dx = endX - startX
        const dy = endY - startY
        const dt = Date.now() - startedAt

        // “下拉”判定：向下、距离足够、横向偏移不大、动作不拖泥带水
        if (dy < 90) return
        if (Math.abs(dx) > 60) return
        if (dt <= 0 || dt > 650) return

        const now = Date.now()
        if (now - lastOpenAt < 800) return
        lastOpenAt = now

        // 轻微震动：告诉用户“触发了”
        try { vibrate(15) } catch {}
        void openCommandPalette()
      } catch {}
    }, { capture: true, passive: true })
  } catch {}
}

// 监听屏幕旋转
export function onOrientationChange(callback: () => void): void {
  window.addEventListener('orientationchange', callback)
  window.addEventListener('resize', callback)
}

// 请求全屏（移动端沉浸式体验）
export async function requestFullscreen(): Promise<void> {
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen()
    }
  } catch (err) {
    console.warn('Fullscreen request failed:', err)
  }
}

// 退出全屏
export async function exitFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen()
    }
  } catch (err) {
    console.warn('Exit fullscreen failed:', err)
  }
}

// 检测是否为平板设备（横屏且宽度较大）
export function isTablet(): boolean {
  return window.innerWidth >= 768 && window.innerWidth < 1200
}

// 震动反馈（Android 支持）
export function vibrate(pattern: number | number[] = 50): void {
  if ('vibrate' in navigator) {
    navigator.vibrate(pattern)
  }
}
