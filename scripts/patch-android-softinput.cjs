// flymd: 在 Tauri 生成的 Android 工程里打补丁（软键盘遮挡兜底）
//
// 背景：
// - `src-tauri/gen/android` 是 tauri CLI 生成目录，默认被 gitignore
// - 某些 ROM/输入法在 WebView 下不会正确触发页面 resize，导致底部内容被键盘盖住
// - 系统层最简单的做法：MainActivity 设置 windowSoftInputMode=adjustResize
//
// 说明：
// - 这里只做“缺了才补”的最小改动，避免和用户自定义 manifest 打架。

const fs = require('fs')
const path = require('path')

function walk(dir, out = []) {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true })
    for (const it of ents) {
      const p = path.join(dir, it.name)
      if (it.isDirectory()) walk(p, out)
      else out.push(p)
    }
  } catch {}
  return out
}

function patchManifestSoftInput(manifestPath) {
  const s0 = fs.readFileSync(manifestPath, 'utf8')

  // 找 MainActivity 的 <activity ...> 开始标签
  const re = /<activity\b[^>]*android:name\s*=\s*["'][^"']*MainActivity["'][^>]*>/m
  const m = s0.match(re)
  if (!m || m.index == null) return false

  const tag = m[0]
  if (/android:windowSoftInputMode\s*=/.test(tag)) return false

  // 取出一个可用缩进（尽量跟随 android:name 那行）
  let indent = '        '
  try {
    const mi = tag.match(/\n([ \t]*)android:name\b/m)
    if (mi && mi[1] != null) indent = mi[1]
  } catch {}

  const injected = tag.replace(
    /\s*>$/,
    `\n${indent}android:windowSoftInputMode="adjustResize">`,
  )

  if (injected === tag) return false
  const s1 = s0.slice(0, m.index) + injected + s0.slice(m.index + tag.length)
  fs.writeFileSync(manifestPath, s1, 'utf8')
  return true
}

function main() {
  const projectRoot = process.cwd()
  const appSrc = path.join(projectRoot, 'src-tauri', 'gen', 'android', 'app', 'src')
  if (!fs.existsSync(appSrc)) {
    console.warn('[patch-android-softinput] 未找到 src-tauri/gen/android/app/src（可能还没执行 tauri android init），跳过')
    return
  }

  const manifests = walk(appSrc).filter(p => p.endsWith(path.sep + 'AndroidManifest.xml'))
  if (!manifests.length) {
    console.warn('[patch-android-softinput] 未找到任何 AndroidManifest.xml，跳过')
    return
  }

  let ok = false
  for (const mf of manifests) {
    try {
      if (patchManifestSoftInput(mf)) {
        console.log(`[patch-android-softinput] 已设置 adjustResize: ${mf}`)
        ok = true
      }
    } catch (e) {
      console.warn(`[patch-android-softinput] patch 失败: ${mf} ; ${e?.message || e}`)
    }
  }
  if (!ok) {
    console.log('[patch-android-softinput] 未发现需要修改的 manifest（可能已存在 windowSoftInputMode）')
  }
}

main()
