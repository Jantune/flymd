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
  }

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
    bar.style.touchAction = 'manipulation'
    // 移动端宽度兜底：多按钮时允许换行，且不超过屏幕
    bar.style.maxWidth = 'calc(100vw - 16px)'
    bar.style.flexWrap = 'wrap'
    bar.style.boxSizing = 'border-box'

    type Command = { id: string; label: string; title: string; run: (btn: HTMLButtonElement) => void | Promise<void> }
    const commands: Command[] = [
      { id: 'heading', label: 'H', title: ftText('标题', 'Heading'), run: (btn) => openHeadingMenu(btn) },
      { id: 'bold', label: 'B', title: ftText('加粗', 'Bold'), run: (_btn) => applyBold() },
      { id: 'italic', label: 'I', title: ftText('斜体', 'Italic'), run: (_btn) => applyItalic() },
      { id: 'ol', label: '1.', title: ftText('有序列表', 'Ordered list'), run: (_btn) => applyOrderedList() },
      { id: 'ul', label: '•', title: ftText('无序列表', 'Bullet list'), run: (_btn) => applyBulletList() },
      { id: 'link', label: '🔗', title: ftText('插入链接', 'Insert link'), run: (_btn) => applyLink() },
      { id: 'image', label: 'IMG', title: ftText('插入图片', 'Insert image'), run: (_btn) => applyImage() },
      { id: 'more', label: '⋯', title: ftText('更多功能', 'More'), run: (_btn) => openContextMenu() },
    ]

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

  const updateToolbarVisibilityBySelection = () => {
    if (state.raf) cancelAnimationFrame(state.raf)
    state.raf = requestAnimationFrame(() => {
      state.raf = 0
      if (!enabled()) { try { hideToolbar() } catch {} ; return }
      if (isReadingMode()) { try { hideToolbar() } catch {} ; return }
      if (!hasTextSelection()) { try { hideToolbar() } catch {} ; return }

      const bar = ensureToolbar()
      if (!bar) return

      const rect = getSelectionRect()
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

  const getSourceSelectionRange = (): { doc: string; start: number; end: number; text: string; hasSelection: boolean } => {
    const doc = deps.getDoc() || ''
    const sel = state.lastSourceSel || snapshotSourceSelection(deps.getEditor())
    const start = sel ? (sel.start >>> 0) : 0
    const end = sel ? (sel.end >>> 0) : 0
    const text = sel ? String(sel.text || '') : ''
    const hasSelection = !!text && end > start
    return { doc, start, end, text, hasSelection }
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
      const { doc, start, end } = getSourceSelectionRange()
      const lineStart = doc.lastIndexOf('\n', start - 1) + 1
      let lineEnd = doc.indexOf('\n', end)
      if (lineEnd === -1) lineEnd = doc.length
      const line = doc.slice(lineStart, lineEnd)
      const stripped = line.replace(/^#{1,6}\s+/, '')
      const prefix = '#'.repeat(clamp(level | 0, 1, 6)) + ' '
      const newLine = prefix + stripped
      const nextDoc = doc.slice(0, lineStart) + newLine + doc.slice(lineEnd)
      deps.setDoc(nextDoc)
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
      const { doc, start, end, hasSelection } = getSourceSelectionRange()
      if (!hasSelection) { deps.notice(ftText('请先选中要加粗的文本', 'Select text first'), 'err', 1400); return }
      const next = doc.slice(0, start) + '**' + doc.slice(start, end) + '**' + doc.slice(end)
      deps.setDoc(next)
    } catch (e) {
      deps.notice(ftText('加粗失败: ', 'Bold failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
  }

  const applyItalic = async () => {
    if (deps.isWysiwygActive()) {
      const fn = deps.wysiwyg?.toggleItalic
      if (typeof fn === 'function') { await fn(); return }
      deps.notice(ftText('所见模式暂不支持斜体命令', 'Italic not supported in WYSIWYG'), 'err', 1600)
      return
    }
    try {
      const { doc, start, end, hasSelection } = getSourceSelectionRange()
      if (!hasSelection) { deps.notice(ftText('请先选中要设为斜体的文本', 'Select text first'), 'err', 1400); return }
      const next = doc.slice(0, start) + '*' + doc.slice(start, end) + '*' + doc.slice(end)
      deps.setDoc(next)
    } catch (e) {
      deps.notice(ftText('斜体失败: ', 'Italic failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
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
      const marker = '- '
      const { doc, start, end, hasSelection } = getSourceSelectionRange()
      if (!hasSelection) { deps.notice(ftText('请先选中要转换为列表的内容', 'Select text first'), 'err', 1400); return }

      const before = doc.slice(0, start)
      const body = doc.slice(start, end)
      const after = doc.slice(end)

      const lines = body.split('\n')
      const trimmedLines = lines.map((l) => l.replace(/^\s+/, ''))
      const allMarked = trimmedLines.every((l) => !l || l.startsWith(marker))

      const nextLines = trimmedLines.map((l) => {
        if (!l) return l
        if (allMarked && l.startsWith(marker)) return l.slice(marker.length)
        return marker + l
      })

      const nextDoc = before + nextLines.join('\n') + after
      deps.setDoc(nextDoc)
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
      const { doc, start, end, hasSelection } = getSourceSelectionRange()
      if (!hasSelection) { deps.notice(ftText('请先选中要转换为列表的内容', 'Select text first'), 'err', 1400); return }

      const before = doc.slice(0, start)
      const body = doc.slice(start, end)
      const after = doc.slice(end)

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

      deps.setDoc(before + nextLines.join('\n') + after)
    } catch (e) {
      deps.notice(ftText('列表转换失败: ', 'List failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
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

      const { doc, start, end } = getSourceSelectionRange()
      const before = doc.slice(0, start)
      const after = doc.slice(end)
      const md = `[${result.label}](${result.url})`
      deps.setDoc(before + md + after)
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

      const { doc, start, end } = getSourceSelectionRange()
      const before = doc.slice(0, start)
      const after = doc.slice(end)
      const md = `![${result.alt}](${result.url})`
      deps.setDoc(before + md + after)
    } catch (e) {
      deps.notice(ftText('插入图片失败: ', 'Image failed: ') + String((e as any)?.message || e || ''), 'err', 1800)
    }
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
      updateToolbarVisibilityBySelection()
    }

    try { document.addEventListener('selectionchange', handler, true) } catch {}
    try { window.addEventListener('resize', handler) } catch {}
    try {
      const vv = (window as any).visualViewport as VisualViewport | undefined
      if (vv && typeof vv.addEventListener === 'function') vv.addEventListener('resize', handler)
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
    }

    // 初次刷新
    try { handler() } catch {}
  }

  // 初始化并启动监听
  bindSelectionWatchers()
}
