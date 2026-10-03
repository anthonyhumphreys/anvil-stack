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
        border: "oklch(var(--border))",
        input: "oklch(var(--input))",
        ring: "oklch(var(--ring))",
        background: "oklch(var(--background))",
        foreground: "oklch(var(--foreground))",
        primary: {
          DEFAULT: "oklch(var(--primary))",
          foreground: "oklch(var(--primary-foreground))"
        },
        secondary: {
          DEFAULT: "oklch(var(--secondary))",
          foreground: "oklch(var(--secondary-foreground))"
        },
        muted: {
          DEFAULT: "oklch(var(--muted))",
          foreground: "oklch(var(--muted-foreground))"
        },
        accent: {
          DEFAULT: "oklch(var(--accent))",
          foreground: "oklch(var(--accent-foreground))"
        },
        destructive: {
          DEFAULT: "oklch(var(--destructive))",
          foreground: "oklch(var(--destructive-foreground))"
        },
        card: {
          DEFAULT: "oklch(var(--card))",
          foreground: "oklch(var(--card-foreground))"
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
