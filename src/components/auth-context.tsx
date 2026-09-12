'use client'
import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { api, getToken, setTokens, clearTokens, getStoredUser, setStoredUser } from '@/lib/client-api'

interface AuthValue {
  user: any
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, nickname: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthValue>({
  user: null,
  loading: true,
  login: async () => {},
  register: async () => {},
  logout: () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<any>(getStoredUser())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!getToken()) {
      setLoading(false)
      return
    }
    api('/api/auth/me')
      .then((d) => {
        setUser(d.user)
        setStoredUser(d.user)
      })
      .catch(() => {
        clearTokens()
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const d = await api('/api/auth/login', { method: 'POST', body: { email, password } })
    setTokens(d.accessToken, d.refreshToken)
    setUser(d.user)
    setStoredUser(d.user)
  }, [])

  const register = useCallback(async (email: string, password: string, nickname: string) => {
    const d = await api('/api/auth/register', { method: 'POST', body: { email, password, nickname } })
    setTokens(d.accessToken, d.refreshToken)
    setUser(d.user)
    setStoredUser(d.user)
  }, [])

  useEffect(() => {
    const onUnauthorized = () => {
      clearTokens()
      setUser(null)
    }
    window.addEventListener('fm:unauthorized', onUnauthorized)
    return () => window.removeEventListener('fm:unauthorized', onUnauthorized)
  }, [])

  const logout = useCallback(() => {
    clearTokens()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
