import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Brand } from '../../shared/branding';
import { getBrand, getBuildBrandId } from '../../shared/branding';

const fallbackBrand = getBrand(getBuildBrandId());
const BrandContext = createContext<Brand>(fallbackBrand);

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<Brand>(fallbackBrand);

  useEffect(() => {
    window.brand.get().then(setBrand);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--color-accent', brand.accentColor);
    root.style.setProperty('--color-accent-glow', brand.accentGlow);
    root.style.setProperty('--color-accent-gradient-end', brand.accentGradientEnd);
    document.title = brand.appName;
  }, [brand]);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}
