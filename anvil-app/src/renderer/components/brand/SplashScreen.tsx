import { AnvilLogo } from './AnvilLogo';
import { getBrand, getBuildBrandId } from '../../../shared/branding';

interface SplashScreenProps {
  label?: string;
}

export function SplashScreen({ label }: SplashScreenProps) {
  const brand = getBrand(getBuildBrandId());
  const statusLabel = label ?? `Starting ${brand.appName}`;

  return (
    <div className="anvil-splash" role="status" aria-live="polite" aria-label={statusLabel}>
      <div className="anvil-splash__backdrop" />
      <div className="anvil-splash__scanline" />
      <div className="anvil-splash__content">
        <div className="anvil-splash__crest">
          <AnvilLogo size={176} showGlow />
        </div>
        <div className="anvil-splash__wordmark">
          <span>{brand.appName}</span>
          <small>{statusLabel}</small>
        </div>
        <div className="anvil-splash__progress" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}
