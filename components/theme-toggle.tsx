import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';

export type AppTheme = 'tech' | 'mint' | 'reference';

export const APP_THEME_STORAGE_KEY = 'wutos-dashboard-theme';
const APP_THEMES: AppTheme[] = ['tech', 'mint', 'reference'];

export function readAppTheme(): AppTheme {
  if (typeof window === 'undefined') return 'tech';
  try {
    const stored = window.localStorage.getItem(APP_THEME_STORAGE_KEY);
    return stored === 'mint' || stored === 'reference' ? stored : 'tech';
  } catch {
    return 'tech';
  }
}

export function nextAppTheme(theme: AppTheme): AppTheme {
  const index = APP_THEMES.indexOf(theme);
  return APP_THEMES[(index + 1) % APP_THEMES.length];
}

export function appThemeToggleLabel(theme: AppTheme): string {
  if (theme === 'tech') return '切换为浅绿色主题';
  if (theme === 'mint') return '切换为蓝白参考主题';
  return '切换为工业蓝色主题';
}

export function useAppTheme() {
  const [theme, setTheme] = useState<AppTheme>(readAppTheme);
  const toggleTheme = () => setTheme((current) => nextAppTheme(current));

  useEffect(() => {
    try {
      window.localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is optional; the current page still switches normally.
    }
    document.documentElement.dataset.appTheme = theme;
  }, [theme]);

  return { theme, toggleTheme };
}

export function ThemeToggleButton({
  theme,
  onToggle,
  className = '',
  compact = false,
}: {
  theme: AppTheme;
  onToggle: () => void;
  className?: string;
  compact?: boolean;
}) {
  const label = appThemeToggleLabel(theme);

  return <button
    type="button"
    className={`app-theme-toggle ${compact ? 'is-compact' : ''} ${className}`.trim()}
    onClick={onToggle}
    aria-pressed={theme !== 'tech'}
    title={label}
    aria-label={label}
  >
    <Palette size={15} />
    {!compact && <span>{theme === 'reference' ? '蓝白主题' : theme === 'mint' ? '浅绿主题' : '工业主题'}</span>}
  </button>;
}
