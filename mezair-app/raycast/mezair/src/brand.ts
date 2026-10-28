export type ExtensionBrandId = 'mezair';

export interface ExtensionBrand {
  id: ExtensionBrandId;
  appName: string;
}

export function getExtensionBrand(): ExtensionBrand {
  return {
    id: 'mezair',
    appName: 'Mezair',
  };
}
