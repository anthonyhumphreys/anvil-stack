import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateConfiguration } from 'app-builder-lib/out/util/config/config.js';

const helper = '../../../../scripts/preview-builder-config.mjs';
const { previewBuilderConfig } = await import(helper);

describe('preview packaging protocol isolation', () => {
  it('clears root, macOS and raw plist URL registration without changing normal config', () => {
    const normal = {
      productName: 'Anvil',
      protocols: [{ name: 'Anvil', schemes: ['anvil', 'devhub'] }],
      mac: {
        target: ['dmg', 'zip'],
        protocols: [{ name: 'Anvil', schemes: ['anvil'] }],
        extendInfo: {
          NSMicrophoneUsageDescription: 'Speech',
          CFBundleURLTypes: [{ CFBundleURLSchemes: ['anvil'] }],
        },
      },
    };
    const preview = previewBuilderConfig(normal);
    expect(preview.protocols).toEqual([]);
    expect(preview.mac.protocols).toEqual([]);
    expect(preview.mac.extendInfo.CFBundleURLTypes).toEqual([]);
    expect(preview.mac.extendInfo.NSMicrophoneUsageDescription).toBe('Speech');
    expect(preview.mac.target).toEqual(['dmg', 'zip']);
    expect(normal.protocols[0].schemes).toEqual(['anvil', 'devhub']);
    expect(normal.mac.protocols).toHaveLength(1);
  });

  it('preserves existing package hooks, files and resources in the generated full config', () => {
    const normal = parse(readFileSync('electron-builder.yml', 'utf8'));
    const preview = previewBuilderConfig(normal);
    expect(preview.afterPack).toBe(normal.afterPack);
    expect(preview.files).toEqual(normal.files);
    expect(preview.extraResources).toEqual(normal.extraResources);
    expect(preview.mac.entitlements).toBe(normal.mac.entitlements);
    expect(JSON.parse(JSON.stringify(preview)).protocols).toEqual([]);
  });

  it('gives Linux previews distinct package and executable identities without app links', () => {
    const normal = {
      productName: 'Anvil',
      extraMetadata: { desktopName: 'anvil.desktop' },
      protocols: [{ name: 'Anvil', schemes: ['anvil'] }],
      fileAssociations: [{ ext: 'anvil', mimeType: 'application/x-anvil' }],
      linux: {
        target: ['AppImage', 'deb', 'pacman'],
        executableName: 'anvil',
        protocols: [{ name: 'Anvil', schemes: ['anvil'] }],
        fileAssociations: [{ ext: 'anvil', mimeType: 'application/x-anvil' }],
        mimeTypes: ['x-scheme-handler/anvil'],
        desktop: {
          entry: {
            Name: 'Anvil',
            MimeType: 'x-scheme-handler/anvil;',
            StartupWMClass: 'Anvil',
          },
        },
      },
      appImage: {
        mimeTypes: ['x-scheme-handler/anvil'],
        desktop: { entry: { MimeType: 'x-scheme-handler/anvil;' } },
      },
      deb: {
        packageName: 'anvil',
        mimeTypes: ['x-scheme-handler/anvil'],
        desktop: { entry: { MimeType: 'x-scheme-handler/anvil;' } },
      },
      pacman: {
        packageName: 'anvil',
        mimeTypes: ['x-scheme-handler/anvil'],
        desktop: { entry: { MimeType: 'x-scheme-handler/anvil;' } },
      },
    };
    const productName = 'Anvil Preview PR 12 abcdef01';
    const packageName = 'anvil-preview-pr12-habcdef01';
    const preview = previewBuilderConfig(normal, {
      platform: 'linux',
      productName,
      executableName: packageName,
      packageName,
    });

    expect(preview.protocols).toEqual([]);
    expect(preview.fileAssociations).toEqual([]);
    expect(preview.linux.target).toEqual(['AppImage', 'deb', 'pacman']);
    expect(preview.linux.executableName).toBe(packageName);
    expect(preview.linux.syncDesktopName).toBe(false);
    expect(preview.linux.protocols).toEqual([]);
    expect(preview.linux.fileAssociations).toEqual([]);
    expect(preview.linux.mimeTypes).toEqual([]);
    expect(preview.linux.desktop.entry).toEqual({ Name: productName, StartupWMClass: packageName });
    expect(preview.appImage.mimeTypes).toEqual([]);
    expect(preview.deb.packageName).toBe(packageName);
    expect(preview.pacman.packageName).toBe(packageName);
    expect(preview.extraMetadata.desktopName).toBe(`${packageName}.desktop`);
    for (const target of [preview.appImage, preview.deb, preview.pacman]) {
      expect(target.mimeTypes).toEqual([]);
      expect(target.desktop.entry).toEqual({ Name: productName, StartupWMClass: packageName });
    }
    expect(normal.linux.executableName).toBe('anvil');
    expect(normal.deb.packageName).toBe('anvil');
    expect(normal.extraMetadata.desktopName).toBe('anvil.desktop');
  });

  it('validates the generated Linux preview config with electron-builder schema', async () => {
    const normal = parse(readFileSync('electron-builder.yml', 'utf8'));
    const preview = previewBuilderConfig(normal, {
      platform: 'linux',
      productName: 'Anvil Preview PR 12 abcdef01',
      executableName: 'anvil-preview-pr12-habcdef01',
      packageName: 'anvil-preview-pr12-habcdef01',
    });
    await expect(validateConfiguration(preview, { isEnabled: false })).resolves.toBeUndefined();
  });
});
