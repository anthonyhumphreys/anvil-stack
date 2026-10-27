# Mezair identity

Mezair is pronounced **may-ZAIR**, with stress on the second syllable. The name
comes from a classical riding movement: repeated controlled rises that advance
the horse. The mark combines an M with a lifted neck and foreleg.

`mezair-mark.svg` is the canonical three-shape vector. Keep its proportions,
separate foreleg and clear space intact. The mark uses `currentColor` so embedded
SVGs and masks can follow their surface's foreground colour. The approved
wordmark and pronunciation treatment are recorded in `mezair-identity.png`.
Use the pronunciation in introductory lockups; app and navigation icons use the
mark alone. Use the existing UI typefaces for live, accessible interface text.

`mezair-icon.svg` is the warm-white app tile. Desktop icons have transparent
outer corners; mobile store icons have a full opaque background. Android
adaptive and monochrome foregrounds keep the mark in the central safe area.

After installing Desktop dependencies, regenerate the desktop iconset, macOS
ICNS, companion icons, Raycast icon and video mark from the repository root:

```sh
node scripts/generate-brand-assets.mjs
```

The generator resolves the Desktop toolchain's Sharp installation. macOS is
required to regenerate ICNS with `iconutil`. Website SVGs share the canonical
geometry and adapt their foreground to light and dark surfaces.
