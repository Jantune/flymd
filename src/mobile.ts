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

// 适配虚拟键盘（防止遮挡编辑器）
function adaptVirtualKeyboard(): void {
  // 使用 Visual Viewport API
  if ('visualViewport' in window) {
    const viewport = window.visualViewport!
    const editor = document.getElementById('editor')

    viewport.addEventListener('resize', () => {
      if (!editor) return

      // 计算键盘高度
      const keyboardHeight = window.innerHeight - viewport.height

      if (keyboardHeight > 100) {
        // 键盘弹出
        editor.style.paddingBottom = `${keyboardHeight}px`
      } else {
        // 键盘收起
        editor.style.paddingBottom = '0'
      }
    })
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
