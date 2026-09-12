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

export function verifyToken(token: string, expectedType: 'access' | 'refresh' = 'access'): TokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as TokenPayload
    if (payload.type !== expectedType) return null
    return payload
  } catch {
    return null
  }
}
