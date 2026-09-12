'use client'

let loadPromise: Promise<any> | null = null

export function amapKey(): string {
  return process.env.NEXT_PUBLIC_AMAP_JS_KEY || ''
}

export function amapSecurity(): string {
  return process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE || ''
}

export function isAmapConfigured(): boolean {
  return amapKey().length > 0
}

const PLUGINS = ['AMap.Scale', 'AMap.ToolBar', 'AMap.AutoComplete', 'AMap.PlaceSearch', 'AMap.Geocoder']

export function loadAMap(_plugins: string[] = []): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('AMap 仅在浏览器端可用'))
  }
  const w: any = window
  if (w.AMap) return Promise.resolve(w.AMap)
  if (loadPromise) return loadPromise

  const key = amapKey()
  if (!key) {
    loadPromise = Promise.reject(new Error('未配置高德 JS Key'))
    return loadPromise
  }

  loadPromise = new Promise(function (resolve, reject) {
    const sec = amapSecurity()
    if (sec) {
      w._AMapSecurityConfig = { securityJsCode: sec }
    }
    const pluginParam = PLUGINS.length ? '&plugin=' + PLUGINS.join(',') : ''
    const script = document.createElement('script')
    script.type = 'text/javascript'
    script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + key + pluginParam
    script.onload = function () {
      if (w.AMap) resolve(w.AMap)
      else {
        loadPromise = null
        reject(new Error('高德脚本已加载但未找到 AMap 对象'))
      }
    }
    script.onerror = function () {
      loadPromise = null
      reject(new Error('高德脚本加载失败（检查 Key / 网络）'))
    }
    document.head.appendChild(script)
  })
  return loadPromise
}
