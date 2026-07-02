/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,svelte,ts}'],
  // Mockups use CSS variables for theming; tailwind references them so utility
  // classes (bg-paper, text-ink, etc.) follow light/dark automatically.
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        'paper-warm': 'var(--paper-warm)',
        'paper-warmer': 'var(--paper-warmer)',
        'save-tint': 'var(--save-tint)',
        ink: 'var(--ink)',
        'ink-deep': 'var(--ink-deep)',
        rule: 'var(--rule)',
        muted: 'var(--muted)',
        link: 'var(--link)',
        coral: 'var(--coral)',
        'coral-deep': 'var(--coral-deep)',
        'coral-soft': 'var(--coral-soft)',
        'on-coral': 'var(--on-coral)',
        zap: 'var(--zap)',
        'zap-soft': 'var(--zap-soft)',
        archive: 'var(--archive)',
        'archive-soft': 'var(--archive-soft)'
      },
      fontFamily: {
        sans: [
          '"Space Grotesk"',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif'
        ],
        mono: ['"Courier New"', 'monospace']
      },
      borderRadius: {
        card: '10px',
        pill: '100px'
      },
      maxWidth: {
        page: '1040px'
      }
    }
  },
  plugins: []
};
