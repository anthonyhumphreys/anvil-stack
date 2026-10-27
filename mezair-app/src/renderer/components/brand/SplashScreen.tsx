import { MezairLogo } from './MezairLogo';
import { getBrand, getBuildBrandId } from '../../../shared/branding';

interface SplashScreenProps {
  label?: string;
}

export function SplashScreen({ label }: SplashScreenProps) {
  const brand = getBrand(getBuildBrandId());
  const statusLabel = label ?? `Starting ${brand.appName}`;

  return (
    <div className="mezair-splash" role="status" aria-live="polite" aria-label={statusLabel}>
      <div className="mezair-splash__content">
        <MezairLogo size={176} className="mezair-splash__mark" />
        <div className="mezair-splash__wordmark">
          <span>{brand.appName.toLowerCase()}</span>
          <small>may-ZAIR</small>
        </div>
        <p className="mezair-splash__status">{statusLabel}</p>
        <div className="mezair-splash__progress" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}
