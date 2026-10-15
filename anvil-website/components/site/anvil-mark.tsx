/** The Anvil mark: an anvil in the current text colour, struck by one forge spark. */
export function AnvilMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M9.5 10H29v3q0 1-1 1.2l-4.5 1q-1.9.6-1.9 2.8v2q0 1 1 1.5l3.2 1.4q1.2.6 1.2 1.9V26H8.6v-1.2q0-1.3 1.2-1.9l3.2-1.4q1-.5 1-1.5v-1.8q0-2-2-2.3-5.8-.7-9.6-4.5-.4-.4.2-.5 3.4-.7 6.9-.9z"
      />
      <path className="anvil-mark-spark" fill="oklch(var(--accent))" d="M24 1.8l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
    </svg>
  );
}
