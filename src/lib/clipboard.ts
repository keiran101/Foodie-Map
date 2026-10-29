/**
 * 复制文本到剪贴板。
 *
 * 为什么不用一句 `navigator.clipboard.writeText` 就完事：
 * 平台是 `http://<IP>:3000` 明文部署（没有域名、没有证书），浏览器把这种来源判定为
 * **非安全上下文**，`navigator.clipboard` 直接是 `undefined`。于是原来的实现
 * 一进 try 就抛 TypeError，掉进 `window.prompt` 兜底 —— 而 prompt 在部分
 * 内置浏览器 / 微信 webview 里会被静默抑制，点了「分享」什么也不发生，
 * 这就是「分享有时不可用」的来源。
 *
 * 所以这里按可用性依次降级：
 *   1. 安全上下文 → 异步剪贴板 API（最干净）
 *   2. 否则 → 隐藏 textarea + `document.execCommand('copy')`（明文 http 下依然有效）
 *   3. 都失败 → 返回 false，由调用方把链接摊在页面上让用户自己长按复制
 */

export function canUseAsyncClipboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  )
}

export async function copyText(text: string): Promise<boolean> {
  if (canUseAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 有 API 但被拒绝（权限/焦点），继续走降级
    }
  }

  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // 不能用 display:none —— 那样选不中，execCommand 会失败
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    const prevFocus = document.activeElement as HTMLElement | null
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus()
    return ok
  } catch {
    return false
  }
}
