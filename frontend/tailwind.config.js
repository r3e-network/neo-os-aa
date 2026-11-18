/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sa: {
          // "orange" tokens repurposed to the Neo Soft violet interactive accent
          orange: '#7B61FF',
          darkOrange: '#6A4DF4',
          lightOrange: '#9B87FF',
          dark: '#F4F5F7',
          panel: '#FFFFFF',
          border: '#E6E8EE',
          text: '#1E1E2E',
          muted: '#5B6478',
          success: '#16C784',
          'success-light': '#6ee7b7',
          info: '#3E8CFF',
          'info-light': '#7CB5FF',
          warning: '#F5A623',
          'warning-light': '#fcd34d',
          error: '#EA3943',
          'error-light': '#fda4af',
          purple: '#7B61FF',
          'purple-light': '#9B87FF',
        },
        neo: {
          50: '#e9faf2',
          100: '#d6f7ec',
          200: '#aef0d8',
          300: '#6fe3b8',
          400: '#34d399',
          500: '#16C784',
          600: '#0fb174',
          700: '#0c9c66',
          800: '#0a7d52',
          900: '#08603f',
        },
        dark: {
          900: '#0F172A',
          800: '#1E293B',
          700: '#334155',
          600: '#475569',
        }
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        outfit: ['Outfit', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      backgroundImage: {
        'subtle-glass': 'linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(255, 255, 255, 0.00) 100%)',
        'vibrant-glow': 'radial-gradient(circle at center, rgba(22, 199, 132, 0.1) 0%, transparent 60%)',
        'orange-glow': 'radial-gradient(circle at center, rgba(123, 97, 255, 0.16) 0%, transparent 60%)',
        'hero-gradient': 'linear-gradient(135deg, #8b7bf0 0%, #a99cf5 100%)',
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'fade-in-up': 'fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'float': 'float 6s ease-in-out infinite',
        'float-slow': 'floatSlow 8s ease-in-out infinite',
        'gradient-shift': 'gradientShift 8s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(15px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        floatSlow: {
          '0%, 100%': { transform: 'translateY(0) scale(1)' },
          '50%': { transform: 'translateY(-20px) scale(1.02)' },
        },
        gradientShift: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      boxShadow: {
        'glow-orange': '0 8px 24px rgba(123, 97, 255, 0.18)',
        'glow-orange-sm': '0 2px 12px rgba(123, 97, 255, 0.12)',
        'glow-orange-lg': '0 16px 36px rgba(123, 97, 255, 0.24)',
        'glow-green': '0 8px 24px rgba(22, 199, 132, 0.18)',
        'glow-green-sm': '0 2px 12px rgba(22, 199, 132, 0.12)',
        'glow-green-lg': '0 16px 36px rgba(22, 199, 132, 0.24)',
        'glow-blue': '0 8px 24px rgba(62, 140, 255, 0.14)',
        'glow-blue-sm': '0 2px 12px rgba(62, 140, 255, 0.1)',
        'glow-blue-lg': '0 16px 36px rgba(62, 140, 255, 0.2)',
        'glow-sky': '0 8px 24px rgba(62, 140, 255, 0.15)',
        'glow-emerald': '0 8px 24px rgba(22, 199, 132, 0.15)',
        'glow-emerald-sm': '0 2px 12px rgba(22, 199, 132, 0.1)',
        'glow-panel': '0 8px 24px rgba(20, 22, 38, 0.06)',
        'glow-orange-inset': 'inset 0 0 12px rgba(123, 97, 255, 0.08)',
        'glow-neo-sm': '0 2px 12px rgba(22, 199, 132, 0.12)',
        'glow-green-diffuse': '0 16px 40px rgba(22, 199, 132, 0.06)',
        'glow-orange-hot': '0 2px 10px rgba(123, 97, 255, 0.4)',
        'glow-error-sm': '0 0 6px var(--sa-error)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
  ],
}
