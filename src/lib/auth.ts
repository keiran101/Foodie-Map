import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m'
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '7d'

export interface TokenPayload {
  sub: string
  email: string
  type: 'access' | 'refresh'
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10)
}

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash)
}

export function signAccessToken(user: { id: string; email: string }): string {
  return jwt.sign({ sub: user.id, email: user.email, type: 'access' }, JWT_SECRET, {
    expiresIn: ACCESS_TTL as jwt.SignOptions['expiresIn'],
  })
}

export function signRefreshToken(user: { id: string; email: string }): string {
  return jwt.sign({ sub: user.id, email: user.email, type: 'refresh' }, JWT_SECRET, {
    expiresIn: REFRESH_TTL as jwt.SignOptions['expiresIn'],
  })
}

/** 任务级 token 的有效期。一轮要跑 取媒体→转写→校验→建图，15 分钟不够。 */
const TASK_TTL = process.env.JWT_TASK_TTL || '45m'

/**
 * 任务级 access token —— 平台发起 Agent 任务时签发给 Agent，代表**这一个用户**回写平台。
 *
 * 为什么不用「服务账号 + userId 参数」：那等于给平台加一把能写任意用户的万能钥匙，
 * 且要新增一套鉴权分支。任务级 token 完全复用现有 requireUser，权限天然锁在
 * `sub` 指向的那个用户身上，任务结束即过期，不留长期凭据。
 *
 * `act: 'agent'` 只是标记来源，便于日后审计；鉴权语义与普通 access token 一致。
 */
export function signTaskToken(user: { id: string; email: string }): string {
  return jwt.sign(
    { sub: user.id, email: user.email, type: 'access', act: 'agent' },
    JWT_SECRET,
    { expiresIn: TASK_TTL as jwt.SignOptions['expiresIn'] },
  )
}

export function verifyToken(token: string, expectedType: 'access' | 'refresh' = 'access'): TokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as TokenPayload
    if (payload.type !== expectedType) return null
    return payload
  } catch {
    return null
  }
}
