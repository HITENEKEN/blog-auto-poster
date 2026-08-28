import React, { useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import {
  LayoutDashboard,
  Globe,
  ShoppingBag,
  Search,
  FileText,
  Clock,
  FileCode,
  Settings,
  LogOut,
  Menu,
  X,
  Wifi,
  Bell,
} from 'lucide-react';
import { clsx } from 'clsx';

const navigation = [
  { name: '대시보드', href: '/', icon: LayoutDashboard },
  { name: '블로그 관리', href: '/blogs', icon: Globe },
  { name: '쿠팡 현황', href: '/coupang', icon: ShoppingBag },
  { name: '키워드 리서치', href: '/keywords', icon: Search },
  { name: '포스트 관리', href: '/posts', icon: FileText },
  { name: '자동 포스팅 설정', href: '/scheduler', icon: Clock },
  { name: '템플릿 관리', href: '/templates', icon: FileCode },
  { name: '설정', href: '/settings', icon: Settings },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { isConnected } = useWebSocket();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile sidebar backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border transition-transform duration-200 lg:translate-x-0',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-full flex-col">
          {/* Logo */}
          <div className="flex h-16 items-center justify-between px-4 border-b border-border">
            <NavLink to="/" className="flex items-center gap-2 font-bold text-lg text-primary">
              <span className="hidden lg:inline">Blog Auto Poster</span>
              <span className="lg:hidden">BAP</span>
            </NavLink>
            <button
              className="lg:hidden p-2 rounded-md hover:bg-accent"
              onClick={() => setMobileMenuOpen(false)}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto p-4 space-y-1">
            {navigation.map((item) => {
              const isActive =
                location.pathname === item.href ||
                (item.href !== '/' && location.pathname.startsWith(item.href));
              return (
                <NavLink
                  key={item.name}
                  to={item.href}
                  className={clsx(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <item.icon className="h-5 w-5" />
                  <span>{item.name}</span>
                </NavLink>
              );
            })}
          </nav>

          {/* Connection status & user */}
          <div className="p-4 border-t border-border space-y-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={clsx(
                  'h-2 w-2 rounded-full',
                  isConnected ? 'bg-green-500' : 'bg-red-500',
                )}
              />
              <span>{isConnected ? '실시간 연결됨' : '연결 끊김'}</span>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user?.username}</p>
                <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
              </div>
              <button
                onClick={logout}
                className="p-2 rounded-md hover:bg-accent text-muted-foreground"
                title="로그아웃"
              >
                <LogOut className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 lg:px-6">
          <button
            className="lg:hidden p-2 rounded-md hover:bg-accent"
            onClick={() => setMobileMenuOpen(true)}
          >
            <Menu className="h-6 w-6" />
          </button>

          <div className="flex-1" />

          <div className="flex items-center gap-4">
            {/* Connection indicator */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={clsx(
                  'h-1.5 w-1.5 rounded-full',
                  isConnected ? 'bg-green-500' : 'bg-red-500',
                )}
              />
              <span>{isConnected ? 'Live' : 'Offline'}</span>
            </div>

            {/* Notifications */}
            <button className="relative p-2 rounded-md hover:bg-accent text-muted-foreground">
              <Bell className="h-5 w-5" />
              <span className="absolute top-1 right-1 h-4 w-4 rounded-full bg-red-500 text-[10px] font-medium text-white flex items-center justify-center">
                3
              </span>
            </button>

            {/* Theme toggle */}
            <button className="p-2 rounded-md hover:bg-accent text-muted-foreground">
              <Wifi className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
