/*
  移动端：内置“悬浮工具条”（照搬 public/plugins/floating-toolbar 的交互与外观）

  约束与原则：
  - 只在“有选区”时显示（避免常驻挡内容）
  - 不依赖插件系统（直接内置在主程序）
  - 移动端宽度自适应（避免工具条溢出屏幕）
  - 尽量不破坏桌面端与现有插件生态（默认只在 platform-mobile 启用）
*/

export type BuiltInFloatingToolbarDeps = {
  enabled: () => boolean
  isReadingMode: () => boolean
  getEditor: () => HTMLTextAreaElement | null
  isWysiwygActive: () => boolean
  getDoc: () => string
  setDoc: (next: string) => void
  notice: (msg: string, level?: 'ok' | 'err', ms?: number) => void
  wysiwyg?: {
    applyHeading?: (level: number) => void | Promise<void>
    toggleBold?: () => void | Promise<void>
    toggleItalic?: () => void | Promise<void>
    toggleBulletList?: () => void | Promise<void>
    toggleOrderedList?: () => void | Promise<void>
    applyLink?: (url: string, label: string) => void | Promise<void>
    insertImage?: (src: string, alt?: string) => void | Promise<void>
    getSelectedText?: () => string
  }
}

type DomRectLike = {
  top: number
  left: number
  bottom: number
  right: number
  width: number
  height: number
}

type SourceSelection = { start: number; end: number; text: string }

const TOOLBAR_ID = 'flymd-floating-toolbar-builtin'
const TOOLBAR_PREF_KEY = 'flymd:mobileFloatingToolbar:v1'

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const FT_LOCALE_LS_KEY = 'flymd.locale'
function ftDetectLocale(): 'zh' | 'en' {
  try {
    const lang = (navigator && (navigator.language || (navigator as any).userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function ftGetLocale(): 'zh' | 'en' {
  try {
    const v = localStorage.getItem(FT_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return ftDetectLocale()
}
function ftText(zh: string, en: string): string {
  return ftGetLocale() === 'en' ? en : zh
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function getViewportSize(): { w: number; h: number } {
  try {
    const vv = (window as any).visualViewport as VisualViewport | undefined
    const w = vv?.width || window.innerWidth || document.documentElement.clientWidth || 0
    const h = vv?.height || window.innerHeight || document.documentElement.clientHeight || 0
    return { w, h }
  } catch {
    return { w: window.innerWidth || 0, h: window.innerHeight || 0 }
  }
}

function snapshotSourceSelection(ta: HTMLTextAreaElement | null): SourceSelection | null {
  try {
    if (!ta) return null
    const s0 = Number(ta.selectionStart ?? 0)
    const e0 = Number(ta.selectionEnd ?? 0)
    if (!Number.isFinite(s0) || !Number.isFinite(e0)) return null
    if (s0 === e0) return null
    const start = Math.min(s0, e0)
    const end = Math.max(s0, e0)
    const doc = String(ta.value || '')
    const text = doc.slice(start, end)
    if (!text.trim()) return null
    return { start, end, text }
  } catch {
    return null
  }
}

function getDomSelectionText(): string {
  try {
    const sel = window.getSelection?.()
    const text = sel ? String(sel.toString() || '') : ''
    return text.trim()
  } catch {
    return ''
  }
}

function getDomSelectionRect(): DomRectLike | null {
  try {
    const sel = window.getSelection?.()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!range) return null
    const rect = range.getBoundingClientRect()
    if (!rect) return null
    if (rect.width === 0 && rect.height === 0) return null
    return {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    }
  } catch {
    return null
  }
}

// 计算 textarea 中某个位置的“光标矩形”（足够用于工具条定位）
function getTextareaCaretRect(ta: HTMLTextAreaElement, pos: number): DomRectLike | null {
  try {
    const style = window.getComputedStyle(ta)
    const taRect = ta.getBoundingClientRect()
    const props = [
      'direction',
      'boxSizing',
      'width',
      'height',
      'overflowX',
      'overflowY',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'fontStyle',
      'fontVariant',
      'fontWeight',
      'fontStretch',
      'fontSize',
      'fontFamily',
      'lineHeight',
      'textAlign',
      'textTransform',
      'textIndent',
      'textDecoration',
      'letterSpacing',
      'wordSpacing',
      'tabSize',
    ] as const

    const div = document.createElement('div')
    div.style.position = 'absolute'
    div.style.visibility = 'hidden'
    div.style.whiteSpace = 'pre-wrap'
    div.style.wordWrap = 'break-word'
    div.style.top = '0'
    div.style.left = '-9999px'
    div.style.contain = 'layout style paint'

    for (const p of props) {
      try {
        // @ts-ignore
        div.style[p] = style[p]
      } catch {}
    }

    // textarea 在 WebKit 下需要强制匹配宽度，否则换行计算会偏
    div.style.width = style.width
    div.style.overflow = 'hidden'

    const doc = String(ta.value || '')
    const safePos = clamp(pos >>> 0, 0, doc.length)

    // 关键：把光标前的内容塞进镜像 div，再用一个 span 标记光标位置
    const before = doc.slice(0, safePos)
    const after = doc.slice(safePos) || '.'
    div.textContent = before
    const span = document.createElement('span')
    span.textContent = after
    div.appendChild(span)
    document.body.appendChild(div)

    // span 的偏移就是“光标”的近似位置（注意要减去 textarea 的滚动）
    const borderTop = parseFloat(style.borderTopWidth) || 0
    const borderLeft = parseFloat(style.borderLeftWidth) || 0
    const paddingTop = parseFloat(style.paddingTop) || 0
    const paddingLeft = parseFloat(style.paddingLeft) || 0
    const lineH = (() => {
      const n = parseFloat(style.lineHeight)
      if (Number.isFinite(n) && n > 0) return n
      const fs = parseFloat(style.fontSize) || 16
      return Math.round(fs * 1.4)
    })()

    const left = taRect.left + borderLeft + paddingLeft + span.offsetLeft - (ta.scrollLeft || 0)
    const top = taRect.top + borderTop + paddingTop + span.offsetTop - (ta.scrollTop || 0)

    try { document.body.removeChild(div) } catch {}

    return {
      top,
      left,
      bottom: top + lineH,
      right: left + 1,
      width: 1,
      height: lineH,
    }
  } catch {
    return null
  }
}

export function initBuiltInFloatingToolbar(deps: BuiltInFloatingToolbarDeps): void {
  try {
    const w = window as any
    if (w.__flymdBuiltInFloatingToolbarInited) return
    w.__flymdBuiltInFloatingToolbarInited = true
  } catch {}

  const state = {
    toolbarEl: null as HTMLDivElement | null,
    headingMenuEl: null as HTMLDivElement | null,
    raf: 0 as number,
    lastSourceSel: null as SourceSelection | null,
    dragging: false as boolean,
    dragStartX: 0 as number,
    dragStartY: 0 as number,
    barStartLeft: 0 as number,
    barStartTop: 0 as number,
    // 移动端：长按时强制显示（即便系统尚未更新 selection）
    forceVisible: false as boolean,
    // 强制显示的“保活”截止时间：用于长按后松手，给用户点击按钮的窗口
    forceStickyUntil: 0 as number,
    forceAnchorX: 0 as number,
    forceAnchorY: 0 as number,
    longPressTimer: 0 as any,
    longPressStartX: 0 as number,
    longPressStartY: 0 as number,
    // 始终显示模式
    alwaysShowMode: false as boolean,
    keyboardHeight: 0 as number,
  }

  type ToolbarPrefs = {
    order: string[]
    hidden: string[]
    alwaysShow?: boolean  // 是否始终显示工具条
  }
  const loadToolbarPrefs = (defaults: string[]): ToolbarPrefs => {
    try {
      const raw = localStorage.getItem(TOOLBAR_PREF_KEY)
      if (!raw) return { order: defaults.slice(), hidden: [], alwaysShow: false }
      const parsed = JSON.parse(raw) as Partial<ToolbarPrefs> | null
      const order = Array.isArray(parsed?.order) ? parsed!.order!.filter((x) => typeof x === 'string') : []
      const hidden = Array.isArray(parsed?.hidden) ? parsed!.hidden!.filter((x) => typeof x === 'string') : []
      const alwaysShow = !!parsed?.alwaysShow
      const orderSet = new Set(order)
      // 确保新命令不会"永远不出现"
      const mergedOrder = order.concat(defaults.filter((id) => !orderSet.has(id)))
      return { order: mergedOrder, hidden, alwaysShow }
    } catch {
      return { order: defaults.slice(), hidden: [], alwaysShow: false }
    }
  }

  const saveToolbarPrefs = (prefs: ToolbarPrefs) => {
    try { localStorage.setItem(TOOLBAR_PREF_KEY, JSON.stringify(prefs)) } catch {}
  }

  // 撤销友好插入：通过 execCommand / setRangeText 保持到原生撤销栈（参考主入口实现）
  const insertUndoable = (ta: HTMLTextAreaElement, text: string): boolean => {
    try { ta.focus(); document.execCommand('insertText', false, text); return true } catch {
      try {
        const s = ta.selectionStart >>> 0
        const e = ta.selectionEnd >>> 0
        ta.setRangeText(text, s, e, 'end')
        try { ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })) } catch {
          try { ta.dispatchEvent(new Event('input', { bubbles: true })) } catch {}
        }
        return true
      } catch { return false }
    }
  }

  const replaceRangeUndoable = (
    ta: HTMLTextAreaElement,
    start: number,
    end: number,
    text: string,
    selStartAfter: number,
    selEndAfter: number,
  ): boolean => {
    try {
      const s = Math.max(0, Math.min(ta.value.length, start >>> 0))
      const e = Math.max(0, Math.min(ta.value.length, end >>> 0))
      ta.selectionStart = Math.min(s, e)
      ta.selectionEnd = Math.max(s, e)
      const ok = insertUndoable(ta, text)
      try {
        ta.selectionStart = Math.max(0, Math.min(ta.value.length, selStartAfter >>> 0))
        ta.selectionEnd = Math.max(0, Math.min(ta.value.length, selEndAfter >>> 0))
      } catch {}
      return ok
    } catch {
      return false
    }
  }

  const getEditorOrNull = (): HTMLTextAreaElement | null => {
    try { return deps.getEditor() } catch { return null }
  }

  const getSourceSelFallbackToCaret = (ta: HTMLTextAreaElement | null): { start: number; end: number; text: string; hasSelection: boolean } => {
    try {
      const sel = state.lastSourceSel || snapshotSourceSelection(ta)
      if (sel && sel.end > sel.start) return { start: sel.start >>> 0, end: sel.end >>> 0, text: String(sel.text || ''), hasSelection: true }
    } catch {}
    try {
      if (ta) {
        const s = ta.selectionStart >>> 0
        const e = ta.selectionEnd >>> 0
        if (s !== e) {
          const a = Math.min(s, e)
          const b = Math.max(s, e)
          return { start: a, end: b, text: String(ta.value || '').slice(a, b), hasSelection: true }
        }
        return { start: s, end: e, text: '', hasSelection: false }
      }
    } catch {}
    return { start: 0, end: 0, text: '', hasSelection: false }
  }

  type Command = { id: string; label: string; title: string; run: (btn: HTMLButtonElement) => void | Promise<void> }

  // 标题二级菜单：移动端空间宝贵，别把 H1~H6 这种按钮堆一排
  let headingMenuOutside: ((e: Event) => void) | null = null
  const closeHeadingMenu = () => {
    const el = state.headingMenuEl
    if (!el) return
    try { el.remove() } catch {}
    state.headingMenuEl = null
    if (headingMenuOutside) {
      try { document.removeEventListener('mousedown', headingMenuOutside, true) } catch {}
      try { document.removeEventListener('touchstart', headingMenuOutside, true) } catch {}
      headingMenuOutside = null
    }
  }

  const openHeadingMenu = (anchorBtn: HTMLButtonElement) => {
    try {
      if (state.headingMenuEl) { closeHeadingMenu(); return }

      const menu = document.createElement('div')
      menu.style.position = 'fixed'
      // 高于工具条本体
      menu.style.zIndex = '10000'
      menu.style.display = 'flex'
      menu.style.flexDirection = 'column'
      menu.style.gap = '4px'
      menu.style.padding = '6px'
      menu.style.borderRadius = '8px'
      menu.style.background = 'rgba(30, 30, 30, 0.95)'
      menu.style.boxShadow = '0 4px 12px rgba(0,0,0,0.35)'
      menu.style.userSelect = 'none'
      menu.style.maxWidth = 'min(80vw, 220px)'
      menu.style.boxSizing = 'border-box'

      const addItem = (label: string, title: string, onClick: () => void) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = label
        b.title = title || label
        b.style.border = 'none'
        b.style.padding = '6px 10px'
        b.style.margin = '0'
        b.style.borderRadius = '6px'
        b.style.background = '#444'
        b.style.color = '#fff'
        b.style.cursor = 'pointer'
        b.style.fontSize = '13px'
        b.style.lineHeight = '1.2'
        b.style.textAlign = 'left'
        b.style.touchAction = 'manipulation'
        b.addEventListener('click', (e) => {
          try { e.stopPropagation() } catch {}
          closeHeadingMenu()
          onClick()
        })
        try {
          b.addEventListener('mouseenter', () => { b.style.background = '#666' })
          b.addEventListener('mouseleave', () => { b.style.background = '#444' })
        } catch {}
        menu.appendChild(b)
      }

      for (let i = 1; i <= 6; i++) {
        const lv = i
        addItem(`H${lv}`, ftText(`${lv}级标题`, `Heading ${lv}`), () => { void applyHeading(lv) })
      }

      document.body.appendChild(menu)
      state.headingMenuEl = menu

      const rect = anchorBtn.getBoundingClientRect()
      const { w: vw, h: vh } = getViewportSize()
      const mr = menu.getBoundingClientRect()
      const margin = 6

      let left = rect.left
      let top = rect.bottom + margin

      if (left + mr.width + 8 > vw) left = Math.max(8, vw - mr.width - 8)
      if (left < 8) left = 8

      if (top + mr.height + 8 > vh && rect.top - mr.height - margin >= 8) {
        top = rect.top - mr.height - margin
      }
      if (top < 8) top = 8

      menu.style.left = `${left}px`
      menu.style.top = `${top}px`

      headingMenuOutside = (e: Event) => {
        const t = (e as any).target as Node | null
        if (!t) return
        if (menu.contains(t)) return
        if (anchorBtn.contains(t)) return
        closeHeadingMenu()
      }

      try { document.addEventListener('mousedown', headingMenuOutside, true) } catch {}
      try { document.addEventListener('touchstart', headingMenuOutside, true) } catch {}
    } catch {
      closeHeadingMenu()
    }
  }

  const enabled = () => {
    try { return !!deps.enabled() } catch { return false }
  }

  const isReadingMode = () => {
    try { return !!deps.isReadingMode() } catch { return false }
  }

  const snapToTop = (bar: HTMLDivElement) => {
    try {
      const rect = bar.getBoundingClientRect()
      if (rect.top < 40) {
        bar.style.top = '0px'
        bar.style.left = '0px'
        bar.style.right = '0px'
        bar.style.width = '100%'
        ;(bar as any).dataset.docked = 'top'
      } else {
        ;(bar as any).dataset.docked = ''
      }
    } catch {}
  }

  const onToolbarMouseDown = (e: MouseEvent) => {
    try {
      if (e.button !== 0) return
      const bar = state.toolbarEl
      if (!bar) return

      // 始终显示模式下禁用拖动
      if (state.alwaysShowMode) return

      state.dragging = true
      const rect = bar.getBoundingClientRect()
      state.dragStartX = e.clientX
      state.dragStartY = e.clientY
      state.barStartLeft = rect.left
      state.barStartTop = rect.top

      // 若之前吸顶，拖动时先恢复为普通定位
      try {
        if ((bar as any).dataset?.docked === 'top') {
          bar.style.width = 'auto'
          bar.style.left = `${rect.left}px`
          bar.style.top = `${rect.top}px`
          bar.style.right = ''
          ;(bar as any).dataset.docked = ''
        }
      } catch {}

      const onMove = (ev: MouseEvent) => {
        if (!state.dragging) return
        const dx = ev.clientX - state.dragStartX
        const dy = ev.clientY - state.dragStartY
        const nextLeft = state.barStartLeft + dx
        const nextTop = state.barStartTop + dy
        bar.style.left = `${nextLeft}px`
        bar.style.top = `${nextTop}px`
        bar.style.right = ''
      }

      const onUp = (ev: MouseEvent) => {
        state.dragging = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        snapToTop(bar)
        try { ev.stopPropagation() } catch {}
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      try { e.preventDefault() } catch {}
    } catch {}
  }

  const ensureToolbar = () => {
    if (state.toolbarEl) return state.toolbarEl
    const existing = document.getElementById(TOOLBAR_ID) as HTMLDivElement | null
    if (existing) {
      state.toolbarEl = existing
      return existing
    }

    const bar = document.createElement('div')
    bar.id = TOOLBAR_ID
    bar.style.position = 'fixed'
    bar.style.top = '80px'
    bar.style.right = '40px'
    // 保持与插件一致：工具条本体不要压过扩展市场等高层 UI
    bar.style.zIndex = '9999'
    bar.style.display = 'none'
    bar.style.alignItems = 'center'
    bar.style.gap = '4px'
    bar.style.padding = '4px 8px'
    bar.style.borderRadius = '6px'
    bar.style.background = 'rgba(30, 30, 30, 0.9)'
    bar.style.color = '#fff'
    bar.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)'
    bar.style.userSelect = 'none'
    bar.style.cursor = 'move'
    // 移动端：按钮变多后，用“横向滑动”而不是换行堆叠（更少的特殊情况）
    bar.style.touchAction = 'pan-x'
    // 移动端宽度兜底：不超过屏幕，横向可滚动
    bar.style.maxWidth = 'calc(100vw - 16px)'
    bar.style.flexWrap = 'nowrap'
    bar.style.overflowX = 'auto'
    bar.style.overflowY = 'hidden'
    ;(bar.style as any).webkitOverflowScrolling = 'touch'
    bar.style.boxSizing = 'border-box'

    const allCommands = buildAllCommands()

    const defaultOrder = allCommands.map((c) => c.id)
    const prefs = loadToolbarPrefs(defaultOrder)
    const hidden = new Set(prefs.hidden || [])
    // 防呆：把“设置/更多”藏起来就是自断手脚
    hidden.delete('settings')
    hidden.delete('more')
    const cmdById = new Map(allCommands.map((c) => [c.id, c]))
    const commands: Command[] = prefs.order.map((id) => cmdById.get(id)).filter((x): x is Command => !!x && !hidden.has(x.id))

    commands.forEach((cmd) => {
      const btn = document.createElement('button')
      let pressedSel: SourceSelection | null = null
      btn.type = 'button'
      btn.textContent = cmd.label
      btn.title = cmd.title || cmd.label
      btn.dataset.commandId = cmd.id
      btn.style.border = 'none'
      btn.style.padding = '2px 6px'
      btn.style.margin = '0'
      btn.style.borderRadius = '4px'
      btn.style.background = '#444'
      btn.style.color = '#fff'
      btn.style.cursor = 'pointer'
      btn.style.fontSize = '12px'
      btn.style.lineHeight = '1.4'
      btn.style.minWidth = '28px'
      btn.style.flex = '0 0 auto'
      btn.style.textAlign = 'center'
      btn.style.touchAction = 'manipulation'

      const onPressCapture = (e: Event) => {
        // 关键：在“失焦导致选区消失”之前抓住选区（尤其是移动端）
        try { pressedSel = snapshotSourceSelection(deps.getEditor()) } catch { pressedSel = null }
        if (pressedSel) state.lastSourceSel = pressedSel
        try { (e as any).stopPropagation?.() } catch {}
        // 注意：touch/pointer 上 preventDefault 会导致 click 不触发，别干这种蠢事
        try { if ((e as any).type === 'mousedown') (e as any).preventDefault?.() } catch {}
      }

      try { btn.addEventListener('mousedown', onPressCapture, { capture: true }) } catch {}
      try { btn.addEventListener('touchstart', onPressCapture, { capture: true, passive: true } as any) } catch {}
      try { btn.addEventListener('pointerdown', onPressCapture, { capture: true } as any) } catch {}

      btn.addEventListener('click', (e) => {
        try { e.stopPropagation() } catch {}
        if (pressedSel) state.lastSourceSel = pressedSel
        pressedSel = null
        void cmd.run(btn)
      })

      try {
        btn.addEventListener('mouseenter', () => { btn.style.background = '#666' })
        btn.addEventListener('mouseleave', () => { btn.style.background = '#444' })
      } catch {}

      bar.appendChild(btn)
    })

    // 隐藏横向滚动条（Android WebView）
    try {
      const styleId = 'flymd-ftb-scrollbar-style'
      if (!document.getElementById(styleId)) {
        const st = document.createElement('style')
        st.id = styleId
        st.textContent = `
          #${TOOLBAR_ID}::-webkit-scrollbar{display:none;}
          #${TOOLBAR_ID}{scrollbar-width:none;-ms-overflow-style:none;}
        `
        document.head.appendChild(st)
      }
    } catch {}

    // 拖动吸顶（保持与插件一致；移动端基本不会触发 mousedown）
    try { bar.addEventListener('mousedown', onToolbarMouseDown) } catch {}

    document.body.appendChild(bar)
    state.toolbarEl = bar
    return bar
  }

  const showToolbar = () => {
    const bar = state.toolbarEl
    if (!bar) return
    if (isReadingMode()) {
      try { closeHeadingMenu() } catch {}
      bar.style.display = 'none'
      return
    }
    bar.style.display = 'flex'
  }

  const hideToolbar = () => {
    const bar = state.toolbarEl
    if (!bar) return
    try { closeHeadingMenu() } catch {}
    bar.style.display = 'none'
  }

  const hasTextSelection = () => {
    // 源码模式：优先用 textarea 选区
    try {
      if (!deps.isWysiwygActive()) {
        const sel = state.lastSourceSel || snapshotSourceSelection(deps.getEditor())
        if (sel && sel.text.trim().length > 0) return true
      }
    } catch {}

    // 所见模式：DOM selection
    try {
      const t = getDomSelectionText()
      return t.length > 0
    } catch {}
    return false
  }

  const getSelectionRect = (): DomRectLike | null => {
    // 1) 源码：用 textarea 光标矩形（选区末尾）
    try {
      if (!deps.isWysiwygActive()) {
        const ta = deps.getEditor()
        const sel = state.lastSourceSel || snapshotSourceSelection(ta)
        if (ta && sel) {
          return getTextareaCaretRect(ta, sel.end) || ta.getBoundingClientRect()
        }
      }
    } catch {}

    // 2) 所见：DOM selection
    return getDomSelectionRect()
  }

  const getForcedAnchorRect = (): DomRectLike | null => {
    try {
      if (!state.forceVisible) return null
      const x = state.forceAnchorX || 0
      const y = state.forceAnchorY || 0
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return { left: x, right: x + 1, top: y, bottom: y + 1, width: 1, height: 1 }
    } catch {
      return null
    }
  }

  const updateToolbarVisibilityBySelection = () => {
    if (state.raf) cancelAnimationFrame(state.raf)
    state.raf = requestAnimationFrame(() => {
      state.raf = 0
      if (!enabled()) { try { hideToolbar() } catch {} ; return }
      if (isReadingMode()) { try { hideToolbar() } catch {} ; return }

      // ========== 始终显示模式逻辑 ==========
      const prefs = loadToolbarPrefs(buildAllCommands().map(c => c.id))
      if (prefs.alwaysShow) {
        if (!state.alwaysShowMode) {
          state.alwaysShowMode = true
        }
        const bar = ensureToolbar()
        if (!bar) return

        bar.style.left = '50%'
        bar.style.transform = 'translateX(-50%)'
        bar.style.right = ''
        updateToolbarBottomForAlwaysShow()
        showToolbar()
        return  // 跳过常规选区跟随逻辑
      } else {
        if (state.alwaysShowMode) {
          state.alwaysShowMode = false
          state.keyboardHeight = 0
        }
      }
      // ==========================================

      const hasSel = hasTextSelection()
      if (!hasSel && state.forceVisible) {
        // 长按后松手：允许保留一小段时间；超时后自动收起
        const now = Date.now()
        if (state.forceStickyUntil > 0 && now > state.forceStickyUntil) {
          state.forceVisible = false
          state.forceStickyUntil = 0
        }
      }
      if (!hasSel && !state.forceVisible) { try { hideToolbar() } catch {} ; return }

      const bar = ensureToolbar()
      if (!bar) return

      const rect = getSelectionRect() || getForcedAnchorRect()
      if (rect) {
        const margin = 6
        const { w: viewportWidth, h: viewportHeight } = getViewportSize()

        let left = rect.left
        let top = rect.bottom + margin

        // 先显示一次，让 offsetWidth/Height 有意义
        bar.style.display = 'flex'
        bar.style.right = ''
        bar.style.width = 'auto'

        const barWidth = bar.offsetWidth || 200
        const barHeight = bar.offsetHeight || 36

        // 水平方向防止溢出
        if (left + barWidth + 8 > viewportWidth) {
          left = Math.max(8, viewportWidth - barWidth - 8)
        }
        if (left < 8) left = 8

        // 垂直方向：如果下方空间不够，放到选区上方
        if (top + barHeight + 8 > viewportHeight && rect.top - barHeight - margin >= 8) {
          top = rect.top - barHeight - margin
        }
        if (top < 8) top = 8

        bar.style.left = `${left}px`
        bar.style.top = `${top}px`
      }

      showToolbar()
    })
  }

  const applyHeading = async (level: number) => {
    // 所见模式：走 Milkdown 命令
    if (deps.isWysiwygActive()) {
      const fn = deps.wysiwyg?.applyHeading
      if (typeof fn === 'function') { await fn(level); return }
      deps.notice(ftText('所见模式暂不支持标题命令', 'Heading not supported in WYSIWYG'), 'err', 1600)
      return
    }

    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const doc = String(ta.value || '')
      const { start, end } = getSourceSelFallbackToCaret(ta)
      const lineStart = doc.lastIndexOf('\n', start - 1) + 1
      let lineEnd = doc.indexOf('\n', end)
      if (lineEnd === -1) lineEnd = doc.length
      const line = doc.slice(lineStart, lineEnd)
      const stripped = line.replace(/^#{1,6}\s+/, '')
      const prefix = '#'.repeat(clamp(level | 0, 1, 6)) + ' '
      const newLine = prefix + stripped
      replaceRangeUndoable(ta, lineStart, lineEnd, newLine, lineStart, lineStart + newLine.length)
    } catch (e) {
      deps.notice(ftText('设置标题失败: ', 'Heading failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyBold = async () => {
    if (deps.isWysiwygActive()) {
      const fn = deps.wysiwyg?.toggleBold
      if (typeof fn === 'function') { await fn(); return }
      deps.notice(ftText('所见模式暂不支持加粗命令', 'Bold not supported in WYSIWYG'), 'err', 1600)
      return
    }
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)
      if (!hasSelection) {
        // 无选中时插入 ****，光标放在中间
        const ins = '****'
        replaceRangeUndoable(ta, start, end, ins, start + 2, start + 2)
        return
      }
      const mid = String(ta.value || '').slice(start, end)
      const ins = `**${mid}**`
      replaceRangeUndoable(ta, start, end, ins, start + 2, start + 2 + mid.length)
    } catch (e) {
      deps.notice(ftText('加粗失败: ', 'Bold failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyItalic = async () => {
    if (deps.isWysiwygActive()) {
      const fn = deps.wysiwyg?.toggleItalic
      if (typeof fn === 'function') { await fn(); return }
      deps.notice(ftText('所见模式暂不支��斜体命令', 'Italic not supported in WYSIWYG'), 'err', 1600)
      return
    }
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)
      if (!hasSelection) {
        // 无选中时插入 **，光标放在中间
        const ins = '**'
        replaceRangeUndoable(ta, start, end, ins, start + 1, start + 1)
        return
      }
      const mid = String(ta.value || '').slice(start, end)
      const ins = `*${mid}*`
      replaceRangeUndoable(ta, start, end, ins, start + 1, start + 1 + mid.length)
    } catch (e) {
      deps.notice(ftText('斜体失败: ', 'Italic failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyTodo = async () => {
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const { start, end } = getSourceSelFallbackToCaret(ta)
      // 插入待办语法 - [ ] 并在后面添加空格，光标放在空格后
      const ins = '- [ ] '
      replaceRangeUndoable(ta, start, end, ins, start + ins.length, start + ins.length)
    } catch (e) {
      deps.notice(ftText('插入待办失败: ', 'Todo failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyUnderline = async () => {
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)
      const mid = hasSelection ? String(ta.value || '').slice(start, end) : ''
      if (!hasSelection) {
        const ins = '<u></u>'
        replaceRangeUndoable(ta, start, end, ins, start + 3, start + 3)
        return
      }
      const ins = `<u>${mid}</u>`
      replaceRangeUndoable(ta, start, end, ins, start + 3, start + 3 + mid.length)
    } catch (e) {
      deps.notice(ftText('下划线失败: ', 'Underline failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyStrikethrough = async () => {
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)
      const mid = hasSelection ? String(ta.value || '').slice(start, end) : ''
      if (!hasSelection) {
        const ins = '~~~~'
        replaceRangeUndoable(ta, start, end, ins, start + 2, start + 2)
        return
      }
      const ins = `~~${mid}~~`
      replaceRangeUndoable(ta, start, end, ins, start + 2, start + 2 + mid.length)
    } catch (e) {
      deps.notice(ftText('删除线失败: ', 'Strikethrough failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyCodeBlock = async () => {
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)
      const mid = hasSelection ? String(ta.value || '').slice(start, end) : ''
      if (!hasSelection) {
        const ins = '```\n\n```'
        replaceRangeUndoable(ta, start, end, ins, start + 4, start + 4)
        return
      }
      const content = `\n${mid}\n`
      const ins = '```' + content + '```'
      replaceRangeUndoable(ta, start, end, ins, start + 4, start + 4 + mid.length)
    } catch (e) {
      deps.notice(ftText('代码块失败: ', 'Code block failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyBlockquote = async () => {
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const doc = String(ta.value || '')
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)

      const quoteLines = (text: string): { next: string; delta: number } => {
        const lines = text.split('\n')
        const isAllQuoted = lines.filter((l) => l.trim().length > 0).every((l) => /^\s{0,3}>\s?/.test(l))
        const nextLines = lines.map((l) => {
          if (!l) return l
          if (isAllQuoted) return l.replace(/^\s{0,3}>\s?/, '')
          return '> ' + l
        })
        const next = nextLines.join('\n')
        return { next, delta: next.length - text.length }
      }

      if (!hasSelection) {
        const lineStart = doc.lastIndexOf('\n', start - 1) + 1
        let lineEnd = doc.indexOf('\n', start)
        if (lineEnd < 0) lineEnd = doc.length
        const line = doc.slice(lineStart, lineEnd)
        const { next } = quoteLines(line)
        replaceRangeUndoable(ta, lineStart, lineEnd, next, lineStart, lineStart + next.length)
        return
      }

      const body = doc.slice(start, end)
      const { next } = quoteLines(body)
      replaceRangeUndoable(ta, start, end, next, start, start + next.length)
    } catch (e) {
      deps.notice(ftText('引用失败: ', 'Quote failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyBulletList = async () => {
    if (deps.isWysiwygActive()) {
      const fn = deps.wysiwyg?.toggleBulletList
      if (typeof fn === 'function') { await fn(); return }
      deps.notice(ftText('所见模式暂不支持列表命令', 'List not supported in WYSIWYG'), 'err', 1600)
      return
    }
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const marker = '- '
      const doc = String(ta.value || '')
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)
      if (!hasSelection) { deps.notice(ftText('请先选中要转换为列表的内容', 'Select text first'), 'err', 1400); return }

      const body = doc.slice(start, end)

      const lines = body.split('\n')
      const trimmedLines = lines.map((l) => l.replace(/^\s+/, ''))
      const allMarked = trimmedLines.every((l) => !l || l.startsWith(marker))

      const nextLines = trimmedLines.map((l) => {
        if (!l) return l
        if (allMarked && l.startsWith(marker)) return l.slice(marker.length)
        return marker + l
      })

      const nextBody = nextLines.join('\n')
      replaceRangeUndoable(ta, start, end, nextBody, start, start + nextBody.length)
    } catch (e) {
      deps.notice(ftText('列表转换失败: ', 'List failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyOrderedList = async () => {
    if (deps.isWysiwygActive()) {
      const fn = deps.wysiwyg?.toggleOrderedList
      if (typeof fn === 'function') { await fn(); return }
      deps.notice(ftText('所见模式暂不支持列表命令', 'List not supported in WYSIWYG'), 'err', 1600)
      return
    }
    try {
      const ta = getEditorOrNull()
      if (!ta) return
      const doc = String(ta.value || '')
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)
      if (!hasSelection) { deps.notice(ftText('请先选中要转换为列表的内容', 'Select text first'), 'err', 1400); return }

      const body = doc.slice(start, end)

      const lines = body.split('\n')
      const trimmedLines = lines.map((l) => l.replace(/^\s+/, ''))
      const allMarked = trimmedLines.every((l) => !l || /^\d+\.\s+/.test(l))

      let idx = 1
      const nextLines = trimmedLines.map((l) => {
        if (!l) return l
        if (allMarked) return l.replace(/^\d+\.\s+/, '')
        const n = idx++
        return `${n}. ${l}`
      })

      const nextBody = nextLines.join('\n')
      replaceRangeUndoable(ta, start, end, nextBody, start, start + nextBody.length)
    } catch (e) {
      deps.notice(ftText('列表转换失败: ', 'List failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const doUndo = () => {
    try {
      const ta = getEditorOrNull()
      if (ta) ta.focus()
      document.execCommand('undo')
    } catch {
      deps.notice(ftText('撤销失败', 'Undo failed'), 'err', 1400)
    }
  }

  const doRedo = () => {
    try {
      const ta = getEditorOrNull()
      if (ta) ta.focus()
      document.execCommand('redo')
    } catch {
      deps.notice(ftText('重做失败', 'Redo failed'), 'err', 1400)
    }
  }

  const openLinkDialogLikePlugin = async (currentText: string) => {
    return await new Promise<{ url: string; label: string } | null>((resolve) => {
      try {
        const overlay = document.createElement('div')
        overlay.style.position = 'fixed'
        overlay.style.inset = '0'
        overlay.style.background = 'rgba(0,0,0,0.35)'
        overlay.style.zIndex = '90010'

        const panel = document.createElement('div')
        panel.style.position = 'absolute'
        panel.style.top = '50%'
        panel.style.left = '50%'
        panel.style.transform = 'translate(-50%, -50%)'
        panel.style.background = '#fff'
        panel.style.padding = '16px 20px'
        panel.style.borderRadius = '12px'
        panel.style.width = 'min(92vw, 420px)'
        panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)'
        panel.style.fontSize = '14px'

        const safeText = (s: string) => String(s || '').replace(/\"/g, '')
        const hasLabel = !!(currentText && currentText.trim().length)

        let html = `
          <h3 style="margin:0 0 12px;font-size:16px;">${ftText('插入链接', 'Insert link')}</h3>
          <div style="margin:6px 0;">
            <div style="margin-bottom:4px;">${ftText('链接地址', 'URL')}</div>
            <input id="ft-link-url" type="text" value="https://"
              style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #ddd;box-sizing:border-box;">
          </div>
        `
        if (!hasLabel) {
          html += `
            <div style="margin:6px 0;">
              <div style="margin-bottom:4px;">${ftText('链接文本', 'Label')}</div>
              <input id="ft-link-label" type="text" value="${safeText(currentText || ftText('链接文本', 'Link'))}"
                style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #ddd;box-sizing:border-box;">
            </div>
          `
        }
        html += `
          <div style="margin-top:14px;text-align:right;">
            <button id="ft-link-cancel" style="margin-right:8px;padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;cursor:pointer;">${ftText('取消', 'Cancel')}</button>
            <button id="ft-link-ok" style="padding:6px 12px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;">${ftText('确定', 'OK')}</button>
          </div>
        `
        panel.innerHTML = html
        overlay.appendChild(panel)
        document.body.appendChild(overlay)

        const urlInput = panel.querySelector('#ft-link-url') as HTMLInputElement | null
        const labelInput = panel.querySelector('#ft-link-label') as HTMLInputElement | null
        const cancelBtn = panel.querySelector('#ft-link-cancel') as HTMLButtonElement | null
        const okBtn = panel.querySelector('#ft-link-ok') as HTMLButtonElement | null

        try { urlInput?.focus(); urlInput?.select() } catch {}

        const cleanup = () => { try { overlay.remove() } catch {} }

        cancelBtn && (cancelBtn.onclick = () => { cleanup(); resolve(null) })
        okBtn && (okBtn.onclick = () => {
          const url = (urlInput?.value || '').trim()
          let label = hasLabel ? currentText.trim() : (labelInput?.value || '').trim()
          if (!url) { deps.notice(ftText('链接地址不能为空', 'URL is required'), 'err', 1400); return }
          if (!label) label = ftText('链接文本', 'Link')
          cleanup()
          resolve({ url, label })
        })

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) { cleanup(); resolve(null) }
        })
      } catch {
        resolve(null)
      }
    })
  }

  const applyLink = async () => {
    try {
      const selectedText = (() => {
        if (deps.isWysiwygActive()) {
          try {
            const t = deps.wysiwyg?.getSelectedText?.()
            if (t && t.trim()) return t.trim()
          } catch {}
          return getDomSelectionText()
        }
        const sel = state.lastSourceSel || snapshotSourceSelection(deps.getEditor())
        return sel?.text?.trim() || ''
      })()

      const result = await openLinkDialogLikePlugin(selectedText)
      if (!result) return

      if (deps.isWysiwygActive()) {
        const fn = deps.wysiwyg?.applyLink
        if (typeof fn === 'function') { await fn(result.url, result.label); return }
        deps.notice(ftText('所见模式暂不支持插入链接', 'Link not supported in WYSIWYG'), 'err', 1600)
        return
      }

      const ta = getEditorOrNull()
      if (!ta) return
      const { start, end, hasSelection } = getSourceSelFallbackToCaret(ta)
      const label = hasSelection ? String(ta.value || '').slice(start, end) : result.label
      const md = `[${label}](${result.url})`
      replaceRangeUndoable(ta, start, end, md, start + md.length, start + md.length)
    } catch (e) {
      deps.notice(ftText('插入链接失败: ', 'Link failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const openImageDialogLikePlugin = async (currentText: string) => {
    return await new Promise<{ url: string; alt: string } | null>((resolve) => {
      try {
        const overlay = document.createElement('div')
        overlay.style.position = 'fixed'
        overlay.style.inset = '0'
        overlay.style.background = 'rgba(0,0,0,0.35)'
        overlay.style.zIndex = '90010'

        const panel = document.createElement('div')
        panel.style.position = 'absolute'
        panel.style.top = '50%'
        panel.style.left = '50%'
        panel.style.transform = 'translate(-50%, -50%)'
        panel.style.background = '#fff'
        panel.style.padding = '16px 20px'
        panel.style.borderRadius = '12px'
        panel.style.width = 'min(92vw, 420px)'
        panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)'
        panel.style.fontSize = '14px'

        const safeText = (s: string) => String(s || '').replace(/\"/g, '')
        panel.innerHTML = `
          <h3 style="margin:0 0 12px;font-size:16px;">${ftText('插入图片', 'Insert image')}</h3>
          <div style="margin:6px 0;">
            <div style="margin-bottom:4px;">${ftText('图片地址', 'Image URL')}</div>
            <input id="ft-img-url" type="text" value="https://"
              style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #ddd;box-sizing:border-box;">
          </div>
          <div style="margin:6px 0;">
            <div style="margin-bottom:4px;">${ftText('图片说明（可留空）', 'Alt (optional)')}</div>
            <input id="ft-img-alt" type="text" value="${safeText(currentText || '')}"
              style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #ddd;box-sizing:border-box;">
          </div>
          <div style="margin-top:14px;text-align:right;">
            <button id="ft-img-cancel" style="margin-right:8px;padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;cursor:pointer;">${ftText('取消', 'Cancel')}</button>
            <button id="ft-img-ok" style="padding:6px 12px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;">${ftText('确定', 'OK')}</button>
          </div>
        `

        overlay.appendChild(panel)
        document.body.appendChild(overlay)

        const urlInput = panel.querySelector('#ft-img-url') as HTMLInputElement | null
        const altInput = panel.querySelector('#ft-img-alt') as HTMLInputElement | null
        const cancelBtn = panel.querySelector('#ft-img-cancel') as HTMLButtonElement | null
        const okBtn = panel.querySelector('#ft-img-ok') as HTMLButtonElement | null

        try { urlInput?.focus(); urlInput?.select() } catch {}

        const cleanup = () => { try { overlay.remove() } catch {} }

        cancelBtn && (cancelBtn.onclick = () => { cleanup(); resolve(null) })
        okBtn && (okBtn.onclick = () => {
          const url = (urlInput?.value || '').trim()
          const alt = (altInput?.value || '').trim()
          if (!url) { deps.notice(ftText('图片地址不能为空', 'Image URL is required'), 'err', 1400); return }
          cleanup()
          resolve({ url, alt })
        })

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) { cleanup(); resolve(null) }
        })
      } catch {
        resolve(null)
      }
    })
  }

  const applyImage = async () => {
    try {
      const currentText = (() => {
        if (deps.isWysiwygActive()) {
          try {
            const t = deps.wysiwyg?.getSelectedText?.()
            if (t && t.trim()) return t.trim()
          } catch {}
          return getDomSelectionText()
        }
        const sel = state.lastSourceSel || snapshotSourceSelection(deps.getEditor())
        return sel?.text?.trim() || ''
      })()

      const result = await openImageDialogLikePlugin(currentText)
      if (!result) return

      if (deps.isWysiwygActive()) {
        const fn = deps.wysiwyg?.insertImage
        if (typeof fn === 'function') { await fn(result.url, result.alt); return }
        deps.notice(ftText('所见模式暂不支持插入图片', 'Image not supported in WYSIWYG'), 'err', 1600)
        return
      }

      const md = `![${result.alt}](${result.url})`
      const ta = getEditorOrNull()
      if (!ta) return
      const { start, end } = getSourceSelFallbackToCaret(ta)
      replaceRangeUndoable(ta, start, end, md, start + md.length, start + md.length)
    } catch (e) {
      deps.notice(ftText('插入图片失败: ', 'Image failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  // 始终显示模式：更新工具条底部位置（键盘适配）
  const updateToolbarBottomForAlwaysShow = () => {
    try {
      const bar = state.toolbarEl
      if (!bar || !state.alwaysShowMode) return

      const vv = (window as any).visualViewport as VisualViewport | undefined
      if (!vv) return

      const kb = Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)))
      state.keyboardHeight = kb

      const bottom = kb > 80 ? (kb + 12) : 12
      bar.style.bottom = `calc(var(--flymd-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + ${bottom}px)`
      bar.style.top = ''
      bar.style.left = '50%'
      bar.style.transform = 'translateX(-50%)'
      bar.style.right = ''
    } catch {}
  }

  const rebuildToolbar = () => {
    try { closeHeadingMenu() } catch {}
    try { state.toolbarEl?.remove() } catch {}
    state.toolbarEl = null
    const prefs = loadToolbarPrefs(buildAllCommands().map(c => c.id))
    state.alwaysShowMode = !!prefs.alwaysShow
    state.keyboardHeight = 0
    try { updateToolbarVisibilityBySelection() } catch {}
  }

  const openToolbarSettings = () => {
    try {
      const overlay = document.createElement('div')
      overlay.style.position = 'fixed'
      overlay.style.inset = '0'
      overlay.style.background = 'rgba(0,0,0,0.35)'
      overlay.style.zIndex = '90020'

      const panel = document.createElement('div')
      panel.style.position = 'absolute'
      panel.style.left = '50%'
      panel.style.bottom = 'calc(var(--flymd-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 12px)'
      panel.style.transform = 'translateX(-50%)'
      panel.style.background = '#fff'
      panel.style.borderRadius = '14px'
      panel.style.width = 'min(96vw, 520px)'
      panel.style.maxHeight = 'calc(80vh - var(--flymd-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) - 24px)'
      panel.style.overflow = 'auto'
      panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)'
      panel.style.fontSize = '14px'
      panel.style.boxSizing = 'border-box'

      const all = buildAllCommands()
      const defaultOrder = all.map((c) => c.id)
      const prefs = loadToolbarPrefs(defaultOrder)
      const hidden = new Set(prefs.hidden || [])
      hidden.delete('settings')
      hidden.delete('more')
      const pinned = new Set(['settings', 'more'])

      const header = document.createElement('div')
      header.style.padding = '14px 16px 10px'
      header.style.borderBottom = '1px solid #eee'
      header.innerHTML = `<div style="font-size:16px;font-weight:600;">${ftText('移动端工具条', 'Mobile toolbar')}</div>
        <div style="margin-top:4px;color:#666;font-size:12px;">${ftText('勾选显示，使用 ↑↓ 调整顺序。', 'Toggle visibility and reorder with ↑↓.')}</div>`

      const list = document.createElement('div')
      list.style.padding = '8px 8px 0'

      const render = () => {
        list.innerHTML = ''
        const byId = new Map(all.map((c) => [c.id, c]))
        prefs.order = prefs.order.filter((id) => byId.has(id))

        prefs.order.forEach((id, idx) => {
          const def = byId.get(id)!
          const row = document.createElement('div')
          row.style.display = 'flex'
          row.style.alignItems = 'center'
          row.style.gap = '8px'
          row.style.padding = '10px 8px'
          row.style.borderBottom = '1px solid #f2f2f2'

          const chk = document.createElement('input')
          chk.type = 'checkbox'
          chk.checked = !hidden.has(id)
          if (pinned.has(id)) {
            chk.checked = true
            chk.disabled = true
          }
          chk.onchange = () => {
            if (chk.checked) hidden.delete(id)
            else hidden.add(id)
          }

          const label = document.createElement('div')
          label.style.flex = '1'
          label.style.display = 'flex'
          label.style.flexDirection = 'column'
          label.style.gap = '2px'
          label.innerHTML = `<div>${escapeHtml(def.title || id)}</div><div style="font-size:11px;color:#888;">${escapeHtml(id)}</div>`

          const up = document.createElement('button')
          up.type = 'button'
          up.textContent = '↑'
          up.style.padding = '4px 8px'
          up.style.borderRadius = '8px'
          up.style.border = '1px solid #ddd'
          up.style.background = '#f7f7f7'
          up.disabled = idx === 0
          up.onclick = () => {
            if (idx <= 0) return
            const tmp = prefs.order[idx - 1]
            prefs.order[idx - 1] = prefs.order[idx]
            prefs.order[idx] = tmp
            render()
          }

          const down = document.createElement('button')
          down.type = 'button'
          down.textContent = '↓'
          down.style.padding = '4px 8px'
          down.style.borderRadius = '8px'
          down.style.border = '1px solid #ddd'
          down.style.background = '#f7f7f7'
          down.disabled = idx === prefs.order.length - 1
          down.onclick = () => {
            if (idx >= prefs.order.length - 1) return
            const tmp = prefs.order[idx + 1]
            prefs.order[idx + 1] = prefs.order[idx]
            prefs.order[idx] = tmp
            render()
          }

          row.appendChild(chk)
          row.appendChild(label)
          row.appendChild(up)
          row.appendChild(down)
          list.appendChild(row)
        })
      }

      const escapeHtml = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      render()

      const footer = document.createElement('div')
      footer.style.display = 'flex'
      footer.style.justifyContent = 'space-between'
      footer.style.alignItems = 'center'
      footer.style.padding = '12px 16px'
      footer.style.gap = '8px'

      const btnReset = document.createElement('button')
      btnReset.type = 'button'
      btnReset.textContent = ftText('恢复默认', 'Reset')
      btnReset.style.padding = '8px 12px'
      btnReset.style.borderRadius = '10px'
      btnReset.style.border = '1px solid #ddd'
      btnReset.style.background = '#f5f5f5'
      btnReset.onclick = () => {
        prefs.order = defaultOrder.slice()
        hidden.clear()
        render()
      }

      const btnOk = document.createElement('button')
      btnOk.type = 'button'
      btnOk.textContent = ftText('完成', 'Done')
      btnOk.style.padding = '8px 14px'
      btnOk.style.borderRadius = '10px'
      btnOk.style.border = '1px solid #2563eb'
      btnOk.style.background = '#2563eb'
      btnOk.style.color = '#fff'
      btnOk.onclick = () => {
        const next: ToolbarPrefs = {
          order: prefs.order.slice(),
          hidden: Array.from(hidden).filter((id) => !pinned.has(id)),
          alwaysShow: alwaysShowChk.checked
        }
        saveToolbarPrefs(next)
        try { overlay.remove() } catch {}
        rebuildToolbar()
      }

      footer.appendChild(btnReset)
      footer.appendChild(btnOk)

      panel.appendChild(header)

      // 始终显示复选框
      const alwaysShowSection = document.createElement('div')
      alwaysShowSection.style.padding = '10px 16px'
      alwaysShowSection.style.borderBottom = '1px solid #f2f2f2'
      alwaysShowSection.style.display = 'flex'
      alwaysShowSection.style.alignItems = 'center'
      alwaysShowSection.style.gap = '8px'

      const alwaysShowChk = document.createElement('input')
      alwaysShowChk.type = 'checkbox'
      alwaysShowChk.id = 'ft-always-show-chk'
      alwaysShowChk.checked = !!prefs.alwaysShow

      const alwaysShowLabel = document.createElement('label')
      alwaysShowLabel.htmlFor = 'ft-always-show-chk'
      alwaysShowLabel.style.flex = '1'
      alwaysShowLabel.style.cursor = 'pointer'
      alwaysShowLabel.textContent = ftText('始终显示工具条(固定在底部)', 'Always show toolbar (fixed at bottom)')

      alwaysShowChk.onchange = () => {
        prefs.alwaysShow = alwaysShowChk.checked
      }

      alwaysShowSection.appendChild(alwaysShowChk)
      alwaysShowSection.appendChild(alwaysShowLabel)
      panel.appendChild(alwaysShowSection)

      panel.appendChild(list)
      panel.appendChild(footer)
      overlay.appendChild(panel)
      document.body.appendChild(overlay)

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          try { overlay.remove() } catch {}
        }
      })
    } catch {
      deps.notice(ftText('打开工具条设置失败', 'Failed to open toolbar settings'), 'err', 1600)
    }
  }

  function buildAllCommands(): Command[] {
    return [
      { id: 'heading', label: 'H', title: ftText('标题', 'Heading'), run: (btn) => openHeadingMenu(btn) },
      { id: 'bold', label: 'B', title: ftText('加粗', 'Bold'), run: (_btn) => applyBold() },
      { id: 'italic', label: 'I', title: ftText('斜体', 'Italic'), run: (_btn) => applyItalic() },
      { id: 'todo', label: '☐', title: ftText('待办', 'Todo'), run: (_btn) => applyTodo() },
      { id: 'underline', label: 'U', title: ftText('下划线', 'Underline'), run: (_btn) => applyUnderline() },
      { id: 'strike', label: 'S', title: ftText('删除线', 'Strikethrough'), run: (_btn) => applyStrikethrough() },
      { id: 'codeblock', label: '</>', title: ftText('代码块', 'Code block'), run: (_btn) => applyCodeBlock() },
      { id: 'quote', label: '>', title: ftText('引用', 'Quote'), run: (_btn) => applyBlockquote() },
      { id: 'ol', label: '1.', title: ftText('有序列表', 'Ordered list'), run: (_btn) => applyOrderedList() },
      { id: 'ul', label: '•', title: ftText('无序列表', 'Bullet list'), run: (_btn) => applyBulletList() },
      { id: 'undo', label: '↶', title: ftText('撤销', 'Undo'), run: (_btn) => doUndo() },
      { id: 'redo', label: '↷', title: ftText('重做', 'Redo'), run: (_btn) => doRedo() },
      { id: 'link', label: '🔗', title: ftText('插入链接', 'Insert link'), run: (_btn) => applyLink() },
      { id: 'image', label: 'IMG', title: ftText('插入图片', 'Insert image'), run: (_btn) => applyImage() },
      { id: 'settings', label: '☰', title: ftText('设置工具条', 'Toolbar settings'), run: (_btn) => openToolbarSettings() },
      { id: 'more', label: '⋯', title: ftText('更多功能', 'More'), run: (_btn) => openContextMenu() },
    ]
  }

  const openContextMenu = () => {
    try {
      // 优先打开“右键菜单”（用户期望：选中后的“更多”=上下文菜单）
      const w = window as any
      if (typeof w.flymdOpenContextMenu === 'function') {
        w.flymdOpenContextMenu()
        return
      }
    } catch {}
    // 兜底：顶栏“更多”（避免极少数场景没有右键菜单入口时彻底没法用）
    try {
      const el = document.getElementById('btn-mobile-menu') as HTMLElement | null
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    } catch (e) {
      deps.notice(ftText('打开菜单失败', 'Failed to open menu'), 'err', 1500)
    }
  }

  // 绑定监听：DOM selection + textarea 选区（移动端 select 事件不总可靠，得多兜底）
  const bindSelectionWatchers = () => {
    const handler = () => {
      try { state.lastSourceSel = snapshotSourceSelection(deps.getEditor()) } catch {}
      // 一旦系统已经给出稳定选区，就别再用“强制显示”这套临时补丁
      try {
        if (hasTextSelection()) {
          state.forceVisible = false
          state.forceStickyUntil = 0
        }
      } catch {}
      updateToolbarVisibilityBySelection()
    }

    try { document.addEventListener('selectionchange', handler, true) } catch {}
    try { window.addEventListener('resize', handler) } catch {}
    try {
      const vv = (window as any).visualViewport as VisualViewport | undefined
      if (vv && typeof vv.addEventListener === 'function') {
        vv.addEventListener('resize', () => {
          if (state.alwaysShowMode) {
            updateToolbarBottomForAlwaysShow()
          }
          handler()
        })
      }
    } catch {}

    const ta = deps.getEditor()
    if (ta) {
      try { ta.addEventListener('select', handler) } catch {}
      try { ta.addEventListener('keyup', handler) } catch {}
      try { ta.addEventListener('mouseup', handler) } catch {}
      try { ta.addEventListener('touchend', handler) } catch {}
      try { ta.addEventListener('input', handler) } catch {}
      try { ta.addEventListener('focus', handler) } catch {}
      try { ta.addEventListener('blur', () => { setTimeout(handler, 0) }) } catch {}

      // 长按显示：不阻止系统选字；只是补上“按住不放”期间 UI 不更新的问题
      const clearLP = () => {
        try { if (state.longPressTimer) { clearTimeout(state.longPressTimer); state.longPressTimer = 0 as any } } catch {}
      }
      const cancelForce = () => {
        state.forceVisible = false
        clearLP()
        try { updateToolbarVisibilityBySelection() } catch {}
      }

      try {
        ta.addEventListener('touchstart', (ev: TouchEvent) => {
          try {
            if (!enabled() || isReadingMode()) return
            if (!ev.touches || ev.touches.length !== 1) return
            const t = ev.touches[0]
            state.longPressStartX = t.clientX
            state.longPressStartY = t.clientY
            state.forceAnchorX = t.clientX
            state.forceAnchorY = t.clientY
            state.forceVisible = false
            state.forceStickyUntil = 0
            clearLP()
            state.longPressTimer = (setTimeout as any)(() => {
              try {
                // 已经有选区就让正常逻辑接管；否则强制显示一次
                if (hasTextSelection()) return
                state.forceVisible = true
                // 给用户松手后点击按钮的窗口（别太短，否则又变成“松手就没了”）
                state.forceStickyUntil = Date.now() + 8000
                updateToolbarVisibilityBySelection()
              } catch {}
            }, 360)
          } catch {}
        }, { passive: true } as any)
      } catch {}

      try {
        ta.addEventListener('touchmove', (ev: TouchEvent) => {
          try {
            if (!state.longPressTimer) return
            const t = ev.touches?.[0]
            if (!t) return
            const dx = t.clientX - state.longPressStartX
            const dy = t.clientY - state.longPressStartY
            if ((dx * dx + dy * dy) > (18 * 18)) clearLP()
          } catch {}
        }, { passive: true } as any)
      } catch {}

      try {
        ta.addEventListener('touchend', () => {
          try {
            clearLP()
            // 松手后若无选区：保留工具条一段时间，给用户点按钮（不要立刻消失）
            if (!hasTextSelection() && state.forceVisible) {
              state.forceStickyUntil = Math.max(state.forceStickyUntil || 0, Date.now() + 8000)
            }
            updateToolbarVisibilityBySelection()
          } catch {}
        }, { passive: true } as any)
      } catch {}
      try { ta.addEventListener('touchcancel', cancelForce as any, { passive: true } as any) } catch {}
    }

    // 点击外部时：若当前无选区且是“强制显示”，就收起（避免常驻挡内容）
    try {
      document.addEventListener('touchstart', (e) => {
        try {
          if (!state.forceVisible) return
          if (hasTextSelection()) return
          const bar = state.toolbarEl
          const t = (e as any).target as Node | null
          if (!t) return
          if (bar && bar.contains(t)) return
          const ta = getEditorOrNull()
          if (ta && ta.contains(t as any)) return
          state.forceVisible = false
          state.forceStickyUntil = 0
          updateToolbarVisibilityBySelection()
        } catch {}
      }, { capture: true, passive: true } as any)
    } catch {}

    // 初次刷新
    try { handler() } catch {}
  }

  // 初始化并启动监听
  bindSelectionWatchers()
}
