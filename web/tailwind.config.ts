import type { Config } from 'tailwindcss';

// Design tokens 全部取自 docs/interaction-contract.md §7（v0.2 定稿）。
// 规则：色板/间距/圆角/字号/阴影/z-index 只许引用本配置，不在组件里写魔法值。
// 间距沿用 Tailwind 默认 4px 基数（1=4px … 20=80px），与契约 §7.2 space-* 逐值对应：
//   space-1=4 space-2=8 space-3=12 space-4=16 space-5=20 space-6=24
//   space-8=32 space-10=40 space-12=48 space-16=64 space-20=80
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // §7.2：移动 gutter 16；平板 24；桌面 32
      screens: {
        tablet: '640px',
        desktop: '1024px',
      },
      colors: {
        // §7.4 语义色（浅色主题；深色主题不在 K0 范围）
        canvas: '#F7F8FA',
        surface: '#FFFFFF',
        subtle: '#F1F3F5',
        border: {
          DEFAULT: '#E3E6EA',
          strong: '#CDD3DA',
        },
        text: {
          primary: '#1A1D21',
          secondary: '#5B6470',
          tertiary: '#667085',
          disabled: '#8C8C8C',
        },
        accent: {
          DEFAULT: '#2563EB',
          hover: '#1D4ED8',
          pressed: '#1E40AF',
          subtle: '#DBEAFE',
        },
        success: {
          DEFAULT: '#047857',
          subtle: '#D1FAE5',
        },
        warning: {
          DEFAULT: '#B45309',
          subtle: '#FEF3C7',
        },
        danger: {
          DEFAULT: '#B91C1C',
          subtle: '#FEE2E2',
        },
        info: {
          DEFAULT: '#0369A1',
          subtle: '#E0F2FE',
        },
        // §7.4 Lifecycle 徽标（文字/背景成对；颜色不得单独承载状态，必须配文字）
        lifecycle: {
          captured: { fg: '#4B5563', bg: '#F3F4F6' },
          defined: { fg: '#334155', bg: '#E2E8F0' },
          ready: { fg: '#075985', bg: '#E0F2FE' },
          active: { fg: '#1E40AF', bg: '#DBEAFE' },
          awaiting_acceptance: { fg: '#92400E', bg: '#FEF3C7' },
          accepted: { fg: '#065F46', bg: '#D1FAE5' },
          canceled: { fg: '#667085', bg: '#F3F4F6' },
        },
      },
      fontFamily: {
        // §7.3 字体栈
        sans: ['Inter', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      fontSize: {
        // §7.3 字阶：[size, line-height]
        caption: ['12px', '18px'],
        'body-s': ['14px', '22px'],
        body: ['16px', '26px'],
        'title-s': ['20px', '28px'],
        title: ['24px', '32px'],
        display: ['32px', '40px'],
        mono: ['13px', '20px'],
      },
      borderRadius: {
        // §7.5
        s: '4px',
        m: '8px',
        l: '12px',
        full: '999px',
      },
      boxShadow: {
        // §7.5
        1: '0 1px 2px rgba(16,24,40,.06)',
        2: '0 4px 12px rgba(16,24,40,.08)',
        3: '0 12px 32px rgba(16,24,40,.12)',
      },
      zIndex: {
        // §7.5 层级
        base: '0',
        sticky: '10',
        dropdown: '20',
        drawer: '30',
        modal: '40',
        toast: '50',
      },
      maxWidth: {
        // §7.2：内容最大宽度 1200
        content: '1200px',
      },
      minHeight: {
        // §7.2：触控目标 ≥44
        touch: '44px',
      },
      minWidth: {
        touch: '44px',
      },
    },
  },
  plugins: [],
};

export default config;
