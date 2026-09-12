/** GCJ02(高德/腾讯) -> BD09(百度) 坐标转换 */
export function gcj02ToBd09(lng: number, lat: number): { lng: number; lat: number } {
  const x_PI = (3.14159265358979324 * 3000.0) / 180.0
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * x_PI)
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * x_PI)
  return { lng: z * Math.cos(theta) + 0.0065, lat: z * Math.sin(theta) + 0.006 }
}

export interface NavLink {
  name: string
  url: string
  webUrl: string
}

export interface NavLinks {
  amap: NavLink
  baidu: NavLink
  tencent: NavLink
}

/**
 * 为店铺生成 高德/百度/腾讯 三家导航链接。
 * 采用各家的 Web URI 协议：手机已装 App 会唤起 App，未装则打开网页版，桌面也能用。
 */
export function buildNavLinks(place: { name: string; lng: number; lat: number }): NavLinks {
  const { lng, lat } = place
  const dest = encodeURIComponent(place.name)

  const amapUrl = 'https://uri.amap.com/navigation?to=' + lng + ',' + lat + ',' + dest + '&mode=car&coordinate=gaode'
  const amapWeb = 'https://uri.amap.com/marker?position=' + lng + ',' + lat + '&name=' + dest + '&coordinate=gaode'

  const bd = gcj02ToBd09(lng, lat)
  const baiduUrl = 'https://api.map.baidu.com/direction?destination=latlng:' + bd.lat + ',' + bd.lng + '|name:' + dest + '&coord_type=gcj02&mode=driving&output=html&src=foodiemap'

  const tencentUrl = 'https://apis.map.qq.com/uri/v1/routeplan?type=drive&to=' + dest + '&tocoord=' + lat + ',' + lng + '&referer=foodiemap'

  return {
    amap: { name: '高德地图', url: amapUrl, webUrl: amapWeb },
    baidu: { name: '百度地图', url: baiduUrl, webUrl: baiduUrl },
    tencent: { name: '腾讯地图', url: tencentUrl, webUrl: tencentUrl },
  }
}
