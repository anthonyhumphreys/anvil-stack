import { Composition } from 'remotion';
import { ANVIL_SIZZLE_DURATION, AnvilSizzle } from './AnvilSizzle';
import { ANVIL_LOGO_SPLASH_DURATION, AnvilLogoSplash } from './LogoSplash';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AnvilSizzle"
        component={AnvilSizzle}
        durationInFrames={ANVIL_SIZZLE_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="AnvilLogoSplash"
        component={AnvilLogoSplash}
        durationInFrames={ANVIL_LOGO_SPLASH_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
