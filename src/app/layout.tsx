import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import { AuthProvider } from '@/components/auth-context'
import Header from '@/components/Header'

export const metadata: Metadata = {
  title: '美食探店地图',
  description: '把探店视频变成一张可导航的美食地图，跟着达人合集一家家找店',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-gray-50">
        <AuthProvider>
          <Header />
          <main className="flex-1">{children}</main>
        </AuthProvider>
      </body>
    </html>
  )
}
