export const THEME = {
  primary: '#A78BFA',
  secondary: '#60A5FA',
  success: '#34D399',
  warning: '#FBBF24',
  error: '#F87171',
  muted: '#6B7280',
  bg: '#1F2937',
  gradient: ['#7C3AED', '#A78BFA', '#C084FC'] as [string, string, string],
};

export const STATUS_COLORS: Record<string, string> = {
  idle: '#6B7280',
  active: '#34D399',
  done: '#34D399',
  failed: '#F87171',
};

export const STATUS_ICONS: Record<string, string> = {
  idle: '-',
  active: '>',
  done: '+',
  failed: 'x',
};
