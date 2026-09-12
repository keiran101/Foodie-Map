const AMAP_WEB_KEY = process.env.AMAP_WEB_KEY || ''
const DEFAULT_CITY = process.env.DEFAULT_CITY || '成都'

interface Poi {
  id: string
  name: string
  address: string
  lng: number
  lat: number
  category: string | null
  phone: string | null
}

const cache = new Map<string, { data: Poi[]; ts: number }>()
const TTL = 60 * 60 * 1000 // 1 小时

/** 高德 POI 搜索（服务端代理 + 缓存）。未配置 Key 时返回占位数据，保证开发不被卡住。 */
export async function searchPoi(keyword: string, city?: string): Promise<Poi[]> {
  const cityName = city || DEFAULT_CITY
  const cacheKey = keyword + '|' + cityName
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.ts < TTL) return hit.data

  let pois: Poi[]
  if (!AMAP_WEB_KEY) {
    pois = mockPois(keyword, cityName)
  } else {
    const params = new URLSearchParams({
      key: AMAP_WEB_KEY,
      keywords: keyword,
      city: cityName,
      offset: '10',
      page: '1',
      extensions: 'base',
    })
    const res = await fetch('https://restapi.amap.com/v3/place/text?' + params.toString())
    const json = (await res.json()) as {
      pois?: Array<{ id?: string; name?: string; address?: string; location?: string; type?: string; tel?: string }>
    }
    pois = (json.pois ?? [])
      .filter((p) => p.location)
      .map((p) => {
        const parts = (p.location as string).split(',')
        return {
          id: p.id ?? '',
          name: p.name ?? keyword,
          address: p.address ?? '',
          lng: Number(parts[0]),
          lat: Number(parts[1]),
          category: p.type ?? null,
          phone: typeof p.tel === 'string' ? p.tel : null,
        }
      })
  }

  cache.set(cacheKey, { data: pois, ts: Date.now() })
  return pois
}

/** 占位数据：围绕成都市中心生成模拟候选，用于高德 Key 到位前的开发调试 */
function mockPois(keyword: string, city: string): Poi[] {
  const names = [keyword, keyword + '（旗舰店）', keyword + '（春熙路店）', keyword + '（太古里店）']
  return names.map((name, i) => ({
    id: 'mock-' + i,
    name,
    address: city + '锦江区示例地址' + (i + 1) + '号',
    lng: 104.065 + i * 0.012,
    lat: 30.657 + (i % 2) * 0.009,
    category: '美食',
    phone: null,
  }))
}
