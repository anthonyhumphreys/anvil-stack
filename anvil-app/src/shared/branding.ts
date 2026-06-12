import type { AppTheme } from './types.js';

export type BrandId = 'anvil';

export interface Brand {
  id: BrandId;
  appName: string;
  subtitle: string;
  organisation: string;
  division: string;
  accentColor: string;
  accentGlow: string;
  accentGradientEnd: string;
  appId: string;
  copyright: string;
  showBrandLogo: boolean;
  outroLabel: string;
  defaultTheme: AppTheme;
}

const anvilBrand: Brand = {
  id: 'anvil',
  appName: 'Anvil',
  subtitle: 'Developer mission control',
  organisation: 'anthonyhumphreys.dev',
  division: 'Anvil',
  accentColor: '#fd7e14',
  accentGlow: 'rgba(253, 126, 20, 0.18)',
  accentGradientEnd: '#ffd43b',
  appId: 'dev.anthonyhumphreys.anvil',
  copyright: 'AnthonyHumphreys.dev',
  showBrandLogo: false,
  outroLabel: 'Anvil',
  defaultTheme: 'dark',
};

const brands: Record<BrandId, Brand> = {
  anvil: anvilBrand,
};

const buildBrand = process.env.ANVIL_BUILD_BRAND;

function normaliseBrandId(value: string | undefined): BrandId | null {
  if (value === 'anvil') return 'anvil';
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

export function getBrand(id: BrandId = 'anvil'): Brand {
  return brands[id];
}

export function getBuildBrandId(): BrandId {
  return normaliseBrandId(buildBrand) ?? 'anvil';
}

export function listBrands(): Brand[] {
  return Object.values(brands);
}
