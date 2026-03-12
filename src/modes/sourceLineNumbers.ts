type EditorMode = 'edit' | 'preview'

type Metrics = {
  contentWidth: number
  paddingTop: number
  paddingBottom: number
  lineHeight: number
}

function px(value: string | null | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(String(value || ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function getFlymd(): any {
  return window as any
}

function getEditorMode(): EditorMode {
  try {
    return (getFlymd().flymdGetMode?.() ?? 'edit') as EditorMode
  } catch {
    return 'edit'
  }
}

function isWysiwygMode(): boolean {
  try {
    return !!getFlymd().flymdGetWysiwygEnabled?.()
  } catch {
    return false
  }
}

function getEditorRow(text: string, pos: number): number {
  const end = Math.max(0, Math.min(pos >>> 0, text.length))
  let row = 1
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) row++
  }
  return row
}

function readMetrics(editor: HTMLTextAreaElement): Metrics {
  const style = window.getComputedStyle(editor)
  const paddingLeft = px(style.paddingLeft)
  const paddingRight = px(style.paddingRight)
  let lineHeight = px(style.lineHeight)
  if (!lineHeight) {
    const fontSize = px(style.fontSize, 16)
    lineHeight = fontSize * 1.7
  }
  return {
    contentWidth: Math.max(0, editor.clientWidth - paddingLeft - paddingRight),
    paddingTop: px(style.paddingTop),
    paddingBottom: px(style.paddingBottom),
    lineHeight,
  }
}

function applyMeasureStyle(
  shell: HTMLDivElement,
  editor: HTMLTextAreaElement,
  gutter: HTMLDivElement,
  measure: HTMLDivElement,
  metrics: Metrics,
): void {
  const style = window.getComputedStyle(editor)
  const shared: Array<[string, string]> = [
    ['fontFamily', style.fontFamily],
    ['fontSize', style.fontSize],
    ['fontWeight', style.fontWeight],
    ['fontStyle', style.fontStyle],
    ['lineHeight', style.lineHeight],
    ['letterSpacing', style.letterSpacing],
    ['tabSize', (style as any).tabSize || '4'],
  ]
  for (const [key, value] of shared) {
    try {
      ;(gutter.style as any)[key] = value
      ;(measure.style as any)[key] = value
    } catch {}
  }
  shell.style.setProperty('--editor-line-height', `${metrics.lineHeight}px`)
  gutter.style.paddingTop = `${metrics.paddingTop}px`
  gutter.style.paddingBottom = `${metrics.paddingBottom}px`
  measure.style.width = `${metrics.contentWidth}px`
}

function buildRows(
  text: string,
  lineNumbers: HTMLDivElement,
  measure: HTMLDivElement,
  metrics: Metrics,
): HTMLDivElement[] {
  const lines = String(text || '').split('\n')
  const gutterFrag = document.createDocumentFragment()
  const measureFrag = document.createDocumentFragment()
  const gutterRows: HTMLDivElement[] = []
  const measureRows: HTMLDivElement[] = []
  for (let i = 0; i < lines.length; i++) {
    const lineNo = document.createElement('div')
    lineNo.className = 'editor-line-number'
    lineNo.textContent = String(i + 1)
    gutterFrag.appendChild(lineNo)
    gutterRows.push(lineNo)

    const row = document.createElement('div')
    row.className = 'editor-line-measure-row'
    row.textContent = lines[i] || '\u200b'
    measureFrag.appendChild(row)
    measureRows.push(row)
  }
  lineNumbers.replaceChildren(gutterFrag)
  measure.replaceChildren(measureFrag)
  for (let i = 0; i < gutterRows.length; i++) {
    const height = Math.max(metrics.lineHeight, measureRows[i]?.offsetHeight || 0)
    gutterRows[i].style.height = `${height}px`
  }
  return gutterRows
}

function syncScroll(editor: HTMLTextAreaElement, lineNumbers: HTMLDivElement): void {
  lineNumbers.style.transform = `translateY(${-editor.scrollTop}px)`
}

function setActiveRow(rowEls: HTMLDivElement[], nextRow: number, prevRow: number): number {
  const maxRow = rowEls.length
  const safeRow = Math.max(1, Math.min(nextRow, maxRow || 1))
  if (prevRow > 0 && prevRow <= maxRow) {
    rowEls[prevRow - 1].classList.remove('active')
  }
  if (safeRow > 0 && safeRow <= maxRow) {
    rowEls[safeRow - 1].classList.add('active')
  }
  return safeRow
}

function installLineNumbers(): void {
  try {
    const container = document.querySelector('.container') as HTMLDivElement | null
    const editor = document.getElementById('editor') as HTMLTextAreaElement | null
    if (!container || !editor) return
    const flymd = getFlymd()
    if (flymd.__flymdSourceLineNumbersInit) return
    flymd.__flymdSourceLineNumbersInit = true

    const shell = document.createElement('div')
    shell.className = 'editor-shell'

    const gutter = document.createElement('div')
    gutter.className = 'editor-gutter'
    gutter.setAttribute('aria-hidden', 'true')

    const lineNumbers = document.createElement('div')
    lineNumbers.className = 'editor-line-numbers'
    gutter.appendChild(lineNumbers)

    const surface = document.createElement('div')
    surface.className = 'editor-surface'

    const measure = document.createElement('div')
    measure.className = 'editor-line-measure'
    measure.setAttribute('aria-hidden', 'true')

    const parent = editor.parentElement
    if (!parent) return
    parent.insertBefore(shell, editor)
    shell.appendChild(gutter)
    shell.appendChild(surface)
    surface.appendChild(editor)
    surface.appendChild(measure)

    let lastText = ''
    let lastMetricsKey = ''
    let activeRow = 0
    let rowEls: HTMLDivElement[] = []
    let needsTextRefresh = true
    let needsLayoutRefresh = true
    let raf = 0

    const flush = () => {
      raf = 0
      if (!editor.isConnected) return
      const mode = getEditorMode()
      const wysiwyg = isWysiwygMode()
      const stickyNote = document.body.classList.contains('sticky-note-mode')
      shell.classList.toggle('line-numbers-disabled', mode !== 'edit' || wysiwyg || stickyNote)

      const metrics = readMetrics(editor)
      applyMeasureStyle(shell, editor, gutter, measure, metrics)

      const text = String(editor.value || '')
      const metricsKey = [
        editor.clientWidth,
        metrics.contentWidth,
        metrics.paddingTop,
        metrics.paddingBottom,
        metrics.lineHeight,
        window.getComputedStyle(editor).fontFamily,
        window.getComputedStyle(editor).fontSize,
        window.getComputedStyle(editor).letterSpacing,
      ].join('|')

      const textChanged = needsTextRefresh || text !== lastText
      const layoutChanged = needsLayoutRefresh || metricsKey !== lastMetricsKey
      if (textChanged || layoutChanged) {
        rowEls = buildRows(text, lineNumbers, measure, metrics)
        lastText = text
        lastMetricsKey = metricsKey
        activeRow = 0
      }

      syncScroll(editor, lineNumbers)
      const nextRow = getEditorRow(text, editor.selectionStart >>> 0)
      activeRow = setActiveRow(rowEls, nextRow, activeRow)
      needsTextRefresh = false
      needsLayoutRefresh = false
    }

    const schedule = (kind: 'text' | 'layout' | 'selection' = 'selection') => {
      if (kind === 'text') needsTextRefresh = true
      if (kind === 'layout') needsLayoutRefresh = true
      if (raf) return
      raf = window.requestAnimationFrame(flush)
    }

    editor.addEventListener('input', () => schedule('text'))
    editor.addEventListener('scroll', () => schedule('selection'))
    editor.addEventListener('click', () => schedule('selection'))
    editor.addEventListener('keyup', () => schedule('selection'))
    editor.addEventListener('mouseup', () => schedule('selection'))
    editor.addEventListener('select', () => schedule('selection'))
    editor.addEventListener('focus', () => schedule('selection'))
    editor.addEventListener('cut', () => schedule('text'))
    editor.addEventListener('paste', () => schedule('text'))
    window.addEventListener('resize', () => schedule('layout'))
    window.addEventListener('flymd:mode:changed', () => schedule('layout'))
    window.addEventListener('flymd:theme:changed', () => schedule('layout'))
    window.addEventListener('flymd:localeChanged', () => schedule('layout'))
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === editor) schedule('selection')
    })

    try {
      const ro = new ResizeObserver(() => schedule('layout'))
      ro.observe(surface)
      ro.observe(editor)
    } catch {}

    try {
      let lastProbe = editor.value
      window.setInterval(() => {
        if (!editor.isConnected) return
        const now = String(editor.value || '')
        if (now !== lastProbe) {
          lastProbe = now
          schedule('text')
          return
        }
        if (document.activeElement === editor) schedule('selection')
      }, 240)
    } catch {}

    try {
      if (!flymd.__lineNumbersPatchedOpenFile && typeof flymd.flymdOpenFile === 'function') {
        flymd.__lineNumbersPatchedOpenFile = true
        const original = flymd.flymdOpenFile
        flymd.flymdOpenFile = async (...args: any[]) => {
          const result = await original.apply(flymd, args)
          schedule('text')
          return result
        }
      }
    } catch {}

    try {
      if (!flymd.__lineNumbersPatchedNewFile && typeof flymd.flymdNewFile === 'function') {
        flymd.__lineNumbersPatchedNewFile = true
        const original = flymd.flymdNewFile
        flymd.flymdNewFile = async (...args: any[]) => {
          const result = await original.apply(flymd, args)
          schedule('text')
          return result
        }
      }
    } catch {}

    schedule('layout')
  } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(installLineNumbers, 800)
  })
} else {
  setTimeout(installLineNumbers, 800)
}
