function withoutDesktopMimeType(desktop) {
  if (!desktop) return desktop;
  const { MimeType: _mimeType, ...entry } = desktop.entry ?? {};
  return { ...desktop, entry };
}

function withPreviewDesktopIdentity(options, productName, startupWmClass = productName) {
  if (!productName) {
    return options.desktop ? { desktop: withoutDesktopMimeType(options.desktop) } : {};
  }
  return {
    desktop: {
      ...withoutDesktopMimeType(options.desktop),
      entry: {
        ...withoutDesktopMimeType(options.desktop)?.entry,
        Name: productName,
        StartupWMClass: startupWmClass,
      },
    },
  };
}

function withoutLinuxAppLinks(options, { productName, executableName } = {}) {
  return {
    ...options,
    protocols: [],
    fileAssociations: [],
    mimeTypes: [],
    ...(executableName ? { executableName } : {}),
    syncDesktopName: false,
    ...withPreviewDesktopIdentity(options, productName, executableName),
  };
}

function withoutLinuxTargetMimeTypes(options, productName, executableName) {
  return {
    ...options,
    mimeTypes: [],
    ...withPreviewDesktopIdentity(options, productName, executableName),
  };
}

/** Keep normal packager settings while giving previews separate package and app-link identities. */
export function previewBuilderConfig(
  config,
  { platform = 'darwin', productName, executableName, packageName } = {},
) {
  const preview = {
    ...config,
    protocols: [],
    fileAssociations: [],
    mac: {
      ...config.mac,
      protocols: [],
      extendInfo: {
        ...config.mac?.extendInfo,
        CFBundleURLTypes: [],
      },
    },
  };

  if (platform === 'linux') {
    preview.linux = withoutLinuxAppLinks(config.linux ?? {}, { productName, executableName });
    preview.appImage = withoutLinuxTargetMimeTypes(
      config.appImage ?? {},
      productName,
      executableName,
    );
    preview.deb = {
      ...withoutLinuxTargetMimeTypes(config.deb ?? {}, productName, executableName),
      ...(packageName ? { packageName } : {}),
    };
    preview.pacman = {
      ...withoutLinuxTargetMimeTypes(config.pacman ?? {}, productName, executableName),
      ...(packageName ? { packageName } : {}),
    };
    if (executableName) {
      preview.extraMetadata = {
        ...config.extraMetadata,
        desktopName: `${executableName}.desktop`,
      };
    }
  }

  return preview;
}
