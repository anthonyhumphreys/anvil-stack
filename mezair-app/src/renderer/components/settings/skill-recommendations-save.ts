import { parseSkillRecommendationSources } from '../../../../cloud/contract/skill-recommendations';
import type { SkillRecommendationSource } from '../../../shared/skill-recommendations';

/** Serialize autosaves so a slow response cannot drop the next field's edit. */
export function createSkillRecommendationSaver(
  initialVersion: number,
  initialSources: SkillRecommendationSource[],
  persist: (sources: SkillRecommendationSource[], expectedVersion: number) => Promise<void>,
) {
  let version = initialVersion;
  let saved = JSON.stringify(initialSources);
  let queue: Promise<unknown> = Promise.resolve();
  return {
    async save(input: SkillRecommendationSource[]) {
      const sources = parseSkillRecommendationSources(input);
      const serialized = JSON.stringify(sources);
      const result = queue
        .catch(() => undefined)
        .then(async () => {
          if (serialized !== saved) {
            await persist(sources, version);
            version += 1;
            saved = serialized;
          }
          return { sources, version };
        });
      queue = result;
      return result;
    },
  };
}
