const mezairMarkUrl = new URL('../../assets/mezair-mark.svg', import.meta.url).href;

interface MezairLogoProps {
  size?: number;
  className?: string;
}

export function MezairLogo({ size = 40, className = '' }: MezairLogoProps) {
  return (
    <span
      className={`mezair-logo-mark ${className}`}
      style={{ width: size, height: size, maskImage: `url(${mezairMarkUrl})` }}
      aria-hidden="true"
    />
  );
}

export { mezairMarkUrl };
