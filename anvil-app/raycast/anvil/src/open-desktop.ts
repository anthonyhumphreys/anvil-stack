import { showHUD } from '@raycast/api';
import { openDesktop } from './api';
import { getExtensionBrand } from './brand';

export default async function OpenDesktopCommand() {
  const brand = getExtensionBrand();
  await openDesktop();
  await showHUD(`Opened ${brand.appName}`);
}
