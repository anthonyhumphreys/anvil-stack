import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

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
});
