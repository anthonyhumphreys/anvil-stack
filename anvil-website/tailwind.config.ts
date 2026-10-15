import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";

const config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}", "./content/**/*.md", "../anvil-app/src/renderer/components/chat/shared/**/*.{ts,tsx}", "../anvil-app/src/renderer/components/chat/ChatEmptyState.tsx"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", ...defaultTheme.fontFamily.sans],
        mono: ["var(--font-mono)", ...defaultTheme.fontFamily.mono]
      },
      colors: {
        bg: {
          primary: "oklch(from var(--anvil-chat-bg-primary) l c h / <alpha-value>)",
          secondary: "oklch(from var(--anvil-chat-bg-secondary) l c h / <alpha-value>)",
          tertiary: "oklch(from var(--anvil-chat-bg-tertiary) l c h / <alpha-value>)",
          elevated: "oklch(from var(--anvil-chat-bg-elevated) l c h / <alpha-value>)",
          hover: "oklch(from var(--anvil-chat-bg-hover) l c h / <alpha-value>)",
        },
        text: {
          primary: "oklch(from var(--anvil-chat-text-primary) l c h / <alpha-value>)",
          secondary: "oklch(from var(--anvil-chat-text-secondary) l c h / <alpha-value>)",
          tertiary: "oklch(from var(--anvil-chat-text-tertiary) l c h / <alpha-value>)",
          muted: "oklch(from var(--anvil-chat-text-muted) l c h / <alpha-value>)",
        },
        "border-subtle": "oklch(from var(--anvil-chat-border-subtle) l c h / <alpha-value>)",
        success: "oklch(from var(--anvil-chat-success) l c h / <alpha-value>)",
        warning: "oklch(from var(--anvil-chat-warning) l c h / <alpha-value>)",
        error: "oklch(from var(--anvil-chat-error) l c h / <alpha-value>)",
        info: "oklch(from var(--anvil-chat-info) l c h / <alpha-value>)",
        border: "oklch(var(--border) / <alpha-value>)",
        input: "oklch(var(--input) / <alpha-value>)",
        ring: "oklch(var(--ring) / <alpha-value>)",
        background: "oklch(var(--background) / <alpha-value>)",
        foreground: "oklch(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "oklch(var(--primary) / <alpha-value>)",
          foreground: "oklch(var(--primary-foreground) / <alpha-value>)"
        },
        secondary: {
          DEFAULT: "oklch(var(--secondary) / <alpha-value>)",
          foreground: "oklch(var(--secondary-foreground) / <alpha-value>)"
        },
        muted: {
          DEFAULT: "oklch(var(--muted) / <alpha-value>)",
          foreground: "oklch(var(--muted-foreground) / <alpha-value>)"
        },
        accent: {
          DEFAULT: "oklch(var(--accent) / <alpha-value>)",
          foreground: "oklch(var(--accent-foreground) / <alpha-value>)"
        },
        destructive: {
          DEFAULT: "oklch(var(--destructive) / <alpha-value>)",
          foreground: "oklch(var(--destructive-foreground) / <alpha-value>)"
        },
        card: {
          DEFAULT: "oklch(var(--card) / <alpha-value>)",
          foreground: "oklch(var(--card-foreground) / <alpha-value>)"
        }
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)"
      },
      boxShadow: {
        anvil: "0 18px 55px rgba(14, 18, 22, 0.08)"
      }
    }
  },
  plugins: []
} satisfies Config;

export default config;
