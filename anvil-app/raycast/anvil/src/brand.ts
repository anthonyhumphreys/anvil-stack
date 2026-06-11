export type ExtensionBrandId = 'anvil';

export interface ExtensionBrand {
  id: ExtensionBrandId;
  appName: string;
}

export function getExtensionBrand(): ExtensionBrand {
  return {
    id: 'anvil',
    appName: 'Anvil',
  };
}
