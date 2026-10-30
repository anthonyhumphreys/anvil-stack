import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateConfiguration } from 'app-builder-lib/out/util/config/config.js';
import { DebugLogger } from 'builder-util/out/DebugLogger.js';

const helper = '../../../../scripts/preview-builder-config.mjs';
const { previewBuilderConfig } = await import(helper);

describe('preview packaging protocol isolation', () => {
  it('clears root, macOS and raw plist URL registration without changing normal config', () => {
    const normal = {
      productName: 'Mezair',
      protocols: [{ name: 'Mezair', schemes: ['mezair', 'devhub'] }],
      mac: {
        target: ['dmg', 'zip'],
        protocols: [{ name: 'Mezair', schemes: ['mezair'] }],
        extendInfo: {
          NSMicrophoneUsageDescription: 'Speech',
          CFBundleURLTypes: [{ CFBundleURLSchemes: ['mezair'] }],
        },
      },
    };
    const preview = previewBuilderConfig(normal);
    expect(preview.protocols).toEqual([]);
    expect(preview.mac.protocols).toEqual([]);
    expect(preview.mac.extendInfo.CFBundleURLTypes).toEqual([]);
    expect(preview.mac.extendInfo.NSMicrophoneUsageDescription).toBe('Speech');
    expect(preview.mac.target).toEqual(['dmg', 'zip']);
    expect(normal.protocols[0].schemes).toEqual(['mezair', 'devhub']);
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
      productName: 'Mezair',
      extraMetadata: { desktopName: 'mezair.desktop' },
      protocols: [{ name: 'Mezair', schemes: ['mezair'] }],
      fileAssociations: [{ ext: 'mezair', mimeType: 'application/x-mezair' }],
      linux: {
        target: ['AppImage', 'deb', 'pacman'],
        executableName: 'mezair',
        protocols: [{ name: 'Mezair', schemes: ['mezair'] }],
        fileAssociations: [{ ext: 'mezair', mimeType: 'application/x-mezair' }],
        mimeTypes: ['x-scheme-handler/mezair'],
        desktop: {
          entry: {
            Name: 'Mezair',
            MimeType: 'x-scheme-handler/mezair;',
            StartupWMClass: 'Mezair',
          },
        },
      },
      appImage: {
        mimeTypes: ['x-scheme-handler/mezair'],
        desktop: { entry: { MimeType: 'x-scheme-handler/mezair;' } },
      },
      deb: {
        packageName: 'mezair',
        mimeTypes: ['x-scheme-handler/mezair'],
        desktop: { entry: { MimeType: 'x-scheme-handler/mezair;' } },
      },
      pacman: {
        packageName: 'mezair',
        mimeTypes: ['x-scheme-handler/mezair'],
        desktop: { entry: { MimeType: 'x-scheme-handler/mezair;' } },
      },
    };
    const productName = 'Mezair Preview PR 12 abcdef01';
    const packageName = 'mezair-preview-pr12-habcdef01';
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
    expect(normal.linux.executableName).toBe('mezair');
    expect(normal.deb.packageName).toBe('mezair');
    expect(normal.extraMetadata.desktopName).toBe('mezair.desktop');
  });

  it('validates the generated Linux preview config with electron-builder schema', async () => {
    const normal = parse(readFileSync('electron-builder.yml', 'utf8'));
    const preview = previewBuilderConfig(normal, {
      platform: 'linux',
      productName: 'Mezair Preview PR 12 abcdef01',
      executableName: 'mezair-preview-pr12-habcdef01',
      packageName: 'mezair-preview-pr12-habcdef01',
    });
    await expect(validateConfiguration(preview, new DebugLogger(false))).resolves.toBeUndefined();
  });
});
