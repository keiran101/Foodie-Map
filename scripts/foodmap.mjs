#!/usr/bin/env node
/**
 * foodmap CLI —— 让用户的 Agent（如 WorkBuddy）识别视频/内容中的店铺后，
 * 一键把店铺灌入系统创建合集。
 *
 * 用法：
 *   node scripts/foodmap.mjs login <email> <password> [--base http://127.0.0.1:3000]
 *   node scripts/foodmap.mjs create <json文件|-> [--base URL]     # - 表示从 stdin 读 JSON
 *   node scripts/foodmap.mjs whoami [--base URL]
 *   node scripts/foodmap.mjs help
 *
 * create 输入 JSON 格式：
 * {
 *   "title": "周末成都火锅巡礼",          // 必填
 *   "city": "成都",                      // 可选，用于坐标补全搜索
 *   "description": "跟着视频探店",        // 可选
 *   "coverUrl": "https://...",          // 可选
 *   "visibility": "PUBLIC",             // 可选：PUBLIC | UNLISTED | PRIVATE
 *   "places": [                          // 必填，至少 1 家
 *     { "name": "蜀大侠火锅" },                          // 只有店名 → 自动高德搜索补全坐标
 *     { "name": "小龙坎", "lng": 104.07, "lat": 30.66 }  // 带坐标 → 直接用
 *   ]
 * }
 *
 * 环境变量 FOODMAP_BASE 可设置默认服务地址。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG = path.join(os.homedir(), '.foodmap-cli.json')
const DEFAULT_BASE = process.env.FOODMAP_BASE || 'http://127.0.0.1:3000'

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  } catch {
    return {}
  }
}
function saveConfig(c) {
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2))
}

async function http(base, method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const res = await fetch(base + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error((data && data.error) || ('HTTP ' + res.status))
    err.status = res.status
    throw err
  }
  return data
}

async function refreshToken(base, cfg) {
  if (!cfg.refreshToken) throw new Error('未登录，请先运行: node scripts/foodmap.mjs login <email> <password>')
  const d = await http(base, 'POST', '/api/auth/refresh', { refreshToken: cfg.refreshToken })
  cfg.accessToken = d.accessToken
  cfg.refreshToken = d.refreshToken
  saveConfig(cfg)
  return d.accessToken
}

async function cmdLogin(base, email, password) {
  const d = await http(base, 'POST', '/api/auth/login', { email, password })
  saveConfig({ base, email, accessToken: d.accessToken, refreshToken: d.refreshToken })
  console.log('[OK] 登录成功: ' + (d.user && d.user.nickname) + ' (' + email + ')')
  console.log('     服务地址: ' + base)
}

async function cmdWhoami(base, cfg) {
  if (!cfg.accessToken) {
    console.log('未登录')
    return
  }
  try {
    const d = await http(base, 'GET', '/api/maps?mine=1', undefined, cfg.accessToken)
    console.log('[OK] ' + cfg.email + '  我的合集数: ' + (d.maps ? d.maps.length : 0))
  } catch (e) {
    if (e.status === 401) {
      await refreshToken(base, cfg)
      console.log('[OK] ' + cfg.email + '（已自动续期）')
    } else {
      throw e
    }
  }
}

async function findPoi(base, name, city) {
  const q = new URLSearchParams({ keyword: name })
  if (city) q.set('city', city)
  const d = await http(base, 'GET', '/api/geo/search?' + q.toString())
  const f = d.pois && d.pois[0]
  if (!f) return null
  return {
    name: f.name || name,
    address: typeof f.address === 'string' ? f.address : null,
    lng: f.lng,
    lat: f.lat,
    category: typeof f.category === 'string' ? f.category : null,
    phone: typeof f.phone === 'string' ? f.phone : null,
    id: typeof f.id === 'string' ? f.id : null,
  }
}

async function cmdCreate(base, cfg, input) {
  if (!input.title) throw new Error('缺少必填字段 title')
  const places = Array.isArray(input.places) ? input.places : []
  if (places.length === 0) throw new Error('缺少必填字段 places（至少一家店）')
  const visibility = ['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(input.visibility) ? input.visibility : 'PUBLIC'

  // 缺 city 且需要坐标补全时提示（防止默认城市搜索导致错配）
  const needGeo = places.some((p) => p.lng == null || p.lat == null)
  if (!input.city && needGeo) {
    console.log('[!] 未指定 city，坐标补全将按默认城市搜索，可能匹配到错误店铺')
    console.log('    建议：JSON 顶层加 "city"（如 "深圳"），或给每家店加 "city" 字段')
  }

  let token = cfg.accessToken
  let mapId
  let added = 0
  const missing = []

  const run = async (tk) => {
    const created = await http(base, 'POST', '/api/maps', {
      title: input.title,
      city: input.city || undefined,
      description: input.description || undefined,
      coverUrl: input.coverUrl || undefined,
      visibility,
    }, tk)
    mapId = created.map.id
    for (const p of places) {
      const name = String(p.name || '').trim()
      if (!name) continue
      const lng = p.lng != null ? Number(p.lng) : null
      const lat = p.lat != null ? Number(p.lat) : null
      const strOrNull = (v) => (typeof v === 'string' && v.length > 0 ? v : null)
      let poi = {
        name,
        address: strOrNull(p.address),
        lng,
        lat,
        category: strOrNull(p.category),
        phone: strOrNull(p.phone),
        amapPoiId: strOrNull(p.amapPoiId),
      }
      if (lng == null || lat == null || Number.isNaN(lng) || Number.isNaN(lat)) {
        const found = await findPoi(base, name, p.city || input.city)
        if (found) {
          poi = {
            name: found.name || name,
            address: poi.address || found.address,
            lng: found.lng,
            lat: found.lat,
            category: poi.category || found.category,
            phone: poi.phone || found.phone,
            amapPoiId: found.id,
          }
        } else {
          missing.push(name)
          continue
        }
      }
      await http(base, 'POST', '/api/maps/' + mapId + '/places', {
        name: poi.name,
        address: poi.address || undefined,
        lng: poi.lng,
        lat: poi.lat,
        amapPoiId: poi.amapPoiId || undefined,
        category: poi.category || undefined,
        phone: poi.phone || undefined,
      }, tk)
      added++
    }
  }

  try {
    await run(token)
  } catch (e) {
    if (e.status === 401) {
      token = await refreshToken(base, cfg)
      await run(token)
    } else {
      throw e
    }
  }

  console.log('[OK] 合集已创建: ' + input.title + '（' + added + ' 家店，' + visibility + '）')
  console.log('     链接: ' + base + '/maps/' + mapId)
  if (missing.length > 0) {
    console.log('[!] 未找到坐标、已跳过: ' + missing.join('、'))
    console.log('    可手工补充 lng/lat 后重新 create（或直接网页打开合集手动添加）')
  }
}

function usage() {
  console.log('foodmap CLI - 把 Agent 识别的店铺一键创建为合集')
  console.log('')
  console.log('用法:')
  console.log('  node scripts/foodmap.mjs login <email> <password> [--base URL]')
  console.log('  node scripts/foodmap.mjs create <json文件|-> [--base URL]     # - 从 stdin 读')
  console.log('  node scripts/foodmap.mjs whoami [--base URL]')
  console.log('  node scripts/foodmap.mjs help')
  console.log('')
  console.log('示例:')
  console.log('  node scripts/foodmap.mjs login demo@foodie.test 123456')
  console.log('  echo \'{"title":"视频探店合集","city":"成都","places":[{"name":"蜀大侠火锅"}]}\' | node scripts/foodmap.mjs create -')
  console.log('')
  console.log('环境变量 FOODMAP_BASE 可设默认地址（默认 http://127.0.0.1:3000）')
}

async function main() {
  const argv = process.argv.slice(2)
  let base = DEFAULT_BASE
  const args = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && i + 1 < argv.length) {
      base = argv[i + 1].replace(/\/$/, '')
      i++
    } else {
      args.push(argv[i])
    }
  }
  const cmd = args[0]
  const cfg = loadConfig()
  if (base === DEFAULT_BASE && cfg.base) base = cfg.base
  try {
    if (cmd === 'login') {
      if (!args[1] || !args[2]) throw new Error('用法: login <email> <password>')
      await cmdLogin(base, args[1], args[2])
    } else if (cmd === 'create') {
      if (!args[1]) throw new Error('用法: create <json文件|->')
      let input
      if (args[1] === '-') {
        input = JSON.parse(fs.readFileSync(0, 'utf8'))
      } else {
        input = JSON.parse(fs.readFileSync(args[1], 'utf8'))
      }
      await cmdCreate(base, cfg, input)
    } else if (cmd === 'whoami') {
      await cmdWhoami(base, cfg)
    } else if (cmd === 'help' || cmd === '--help' || cmd === '-h' || !cmd) {
      usage()
    } else {
      throw new Error('未知命令: ' + cmd)
    }
  } catch (e) {
    console.error('[X] ' + e.message)
    process.exit(1)
  }
}

main()
