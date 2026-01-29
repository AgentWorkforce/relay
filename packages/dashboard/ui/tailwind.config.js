/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './react-components/**/*.{js,ts,jsx,tsx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Mission Control Theme - Deep Space
        bg: {
          deep: '#0a0a0f',
          primary: '#0d0d14',
          secondary: '#12121c',
          tertiary: '#181824',
          card: '#1a1a28',
          elevated: '#202030',
          hover: 'rgba(255, 255, 255, 0.04)',
          active: 'rgba(255, 255, 255, 0.08)',
        },
        text: {
          primary: '#f0f0f5',
          secondary: '#a0a0b0',
          muted: '#606070',
          dim: '#404050',
          inverse: '#0a0a0f',
        },
        border: {
          DEFAULT: 'rgba(255, 255, 255, 0.1)',
          subtle: 'rgba(255, 255, 255, 0.06)',
          light: 'rgba(255, 255, 255, 0.1)',
          medium: 'rgba(255, 255, 255, 0.15)',
        },
        // Neon Accent Colors
        accent: {
          DEFAULT: '#00d9ff',
          cyan: '#00d9ff',
          orange: '#ff6b35',
          purple: '#a855f7',
          green: '#00ffc8',
          hover: '#00b8d9',
          light: 'rgba(0, 217, 255, 0.15)',
        },
        // Provider Colors
        provider: {
          claude: '#00d9ff',
          codex: '#ff6b35',
          gemini: '#a855f7',
        },
        // Status Colors
        success: {
          DEFAULT: '#00ffc8',
          light: 'rgba(0, 255, 200, 0.15)',
        },
        warning: {
          DEFAULT: '#ff6b35',
          light: 'rgba(255, 107, 53, 0.15)',
        },
        error: {
          DEFAULT: '#ff4757',
          light: 'rgba(255, 71, 87, 0.15)',
        },
        // Sidebar
        sidebar: {
          bg: '#0d0d14',
          border: 'rgba(255, 255, 255, 0.08)',
          hover: 'rgba(255, 255, 255, 0.06)',
        },
      },
      fontFamily: {
        display: ['Outfit', 'sans-serif'],
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['IBM Plex Mono', 'SF Mono', 'Consolas', 'monospace'],
      },
      fontSize: {
        xs: '11px',
        sm: '13px',
        base: '14px',
        lg: '15px',
        xl: '16px',
        '2xl': '18px',
        '3xl': '24px',
        '4xl': '32px',
      },
      spacing: {
        sidebar: '280px',
        header: '52px',
      },
      borderRadius: {
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
        '2xl': '16px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0, 0, 0, 0.05)',
        md: '0 1px 3px rgba(0, 0, 0, 0.1)',
        lg: '0 4px 6px rgba(0, 0, 0, 0.1)',
        xl: '0 10px 15px rgba(0, 0, 0, 0.1)',
        modal: '0 16px 70px rgba(0, 0, 0, 0.7)',
        'glow-cyan': '0 0 20px rgba(0, 217, 255, 0.3)',
        'glow-orange': '0 0 20px rgba(255, 107, 53, 0.3)',
        'glow-purple': '0 0 20px rgba(168, 85, 247, 0.3)',
        'glow-green': '0 0 20px rgba(0, 255, 200, 0.3)',
      },
      animation: {
        spin: 'spin 1s linear infinite',
        pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 150ms ease',
        'slide-up': 'slideUp 200ms ease',
        'slide-down': 'slideDown 200ms ease',
        'kill-pulse': 'killPulse 0.6s ease-in-out infinite',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          from: { opacity: '0', transform: 'translateY(-10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        killPulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(0, 217, 255, 0.4)' },
          '50%': { opacity: '0.8', boxShadow: '0 0 20px 4px transparent' },
        },
      },
      transitionDuration: {
        fast: '150ms',
        normal: '200ms',
        slow: '300ms',
      },
    },
  },
  plugins: [],
};
