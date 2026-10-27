import { Composition } from 'remotion';
import { MEZAIR_SIZZLE_DURATION, MezairSizzle } from './MezairSizzle';
import { MEZAIR_LOGO_SPLASH_DURATION, MezairLogoSplash } from './LogoSplash';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MezairSizzle"
        component={MezairSizzle}
        durationInFrames={MEZAIR_SIZZLE_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="MezairLogoSplash"
        component={MezairLogoSplash}
        durationInFrames={MEZAIR_LOGO_SPLASH_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
