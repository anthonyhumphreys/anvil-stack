const anvilCrestUrl = new URL('../../assets/anvil-crest.svg', import.meta.url).href;

interface AnvilLogoProps {
  size?: number;
  showGlow?: boolean;
  className?: string;
}

export function AnvilLogo({ size = 40, showGlow = false, className = '' }: AnvilLogoProps) {
  return (
    <span
      className={`anvil-logo-mark ${showGlow ? 'anvil-logo-mark--glow' : ''} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img src={anvilCrestUrl} alt="" draggable={false} />
    </span>
  );
}

export { anvilCrestUrl };
