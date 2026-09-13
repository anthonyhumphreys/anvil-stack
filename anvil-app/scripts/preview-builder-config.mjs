/** Keep the normal packager settings while preventing preview installs from claiming app links. */
export function previewBuilderConfig(config) {
  return {
    ...config,
    protocols: [],
    mac: {
      ...config.mac,
      protocols: [],
      extendInfo: {
        ...config.mac?.extendInfo,
        CFBundleURLTypes: [],
      },
    },
  };
}
