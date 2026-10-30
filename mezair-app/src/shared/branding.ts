import type { AppTheme } from './types.js';

export type BrandId = 'mezair';

export interface Brand {
  id: BrandId;
  appName: string;
  subtitle: string;
  organisation: string;
  division: string;
  accentColor: string;
  accentForeground: string;
  accentGlow: string;
  accentGradientEnd: string;
  appId: string;
  copyright: string;
  showBrandLogo: boolean;
  outroLabel: string;
  defaultTheme: AppTheme;
}

const mezairBrand: Brand = {
  id: 'mezair',
  appName: 'Mezair',
  subtitle: 'Developer mission control',
  organisation: 'anthonyhumphreys.dev',
  division: 'Mezair',
  accentColor: '#fd7e14',
  accentForeground: '#0b1020',
  accentGlow: 'rgba(253, 126, 20, 0.18)',
  accentGradientEnd: '#ffd43b',
  appId: 'dev.anthonyhumphreys.mezair',
  copyright: 'AnthonyHumphreys.dev',
  showBrandLogo: false,
  outroLabel: 'Mezair',
  defaultTheme: 'system',
};

const brands: Record<BrandId, Brand> = {
  mezair: mezairBrand,
};

const buildBrand = process.env.MEZAIR_BUILD_BRAND;

function normaliseBrandId(value: string | undefined): BrandId | null {
  if (value === 'mezair') return 'mezair';
  return null;
}

export function parseBrandFromArgs(argv: string[]): BrandId {
  const flag = argv.find((a) => a.startsWith('--brand='));
  if (flag) {
    const value = normaliseBrandId(flag.split('=')[1]);
    if (value) return value;
  }
  const separateFlagIndex = argv.indexOf('--brand');
  if (separateFlagIndex >= 0) {
    const value = normaliseBrandId(argv[separateFlagIndex + 1]);
    if (value) return value;
  }
  return getBuildBrandId();
}

export function getBrand(id: BrandId = 'mezair'): Brand {
  return brands[id];
}

export function getBuildBrandId(): BrandId {
  return normaliseBrandId(buildBrand) ?? 'mezair';
}

export function listBrands(): Brand[] {
  return Object.values(brands);
}
