import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatReviewFeedbackDraft, DiffReviewPosition } from './chat-review-feedback';

export interface ChatReviewFeedbackContextValue {
  threadId: string | null;
  onComposeFeedback: (draft: ChatReviewFeedbackDraft) => void;
  getDiffReviewPosition: (key: string) => DiffReviewPosition | undefined;
  setDiffReviewPosition: (key: string, position: DiffReviewPosition | undefined) => void;
  getArtifactReviewPosition: (key: string) => ArtifactReviewPosition | undefined;
  setArtifactReviewPosition: (key: string, position: ArtifactReviewPosition) => void;
}

export interface ArtifactReviewPosition {
  mode: 'preview' | 'source';
  scrollTop: number;
}

const ChatReviewFeedbackContext = createContext<ChatReviewFeedbackContextValue | null>(null);

export function ChatReviewFeedbackProvider({
  threadId,
  onComposeFeedback,
  children,
}: {
  threadId: string | null;
  onComposeFeedback: (draft: ChatReviewFeedbackDraft) => void;
  children: ReactNode;
}) {
  const [positionsByThread, setPositionsByThread] = useState<
    Record<string, Record<string, DiffReviewPosition>>
  >({});
  const artifactPositionsByThreadRef = useRef(
    new Map<string, Record<string, ArtifactReviewPosition>>(),
  );
  const threadKey = threadId ?? '__unscoped__';

  const getDiffReviewPosition = useCallback(
    (key: string) => positionsByThread[threadKey]?.[key],
    [positionsByThread, threadKey],
  );
  const setDiffReviewPosition = useCallback(
    (key: string, position: DiffReviewPosition | undefined) => {
      setPositionsByThread((current) => {
        const nextForThread = { ...current[threadKey] };
        if (position) nextForThread[key] = position;
        else delete nextForThread[key];
        return { ...current, [threadKey]: nextForThread };
      });
    },
    [threadKey],
  );

  const getArtifactReviewPosition = useCallback(
    (key: string) => artifactPositionsByThreadRef.current.get(threadKey)?.[key],
    [threadKey],
  );
  const setArtifactReviewPosition = useCallback(
    (key: string, position: ArtifactReviewPosition) => {
      const nextForThread = {
        ...artifactPositionsByThreadRef.current.get(threadKey),
        [key]: position,
      };
      artifactPositionsByThreadRef.current.set(threadKey, nextForThread);
    },
    [threadKey],
  );

  const value = useMemo(
    () => ({
      threadId,
      onComposeFeedback,
      getDiffReviewPosition,
      setDiffReviewPosition,
      getArtifactReviewPosition,
      setArtifactReviewPosition,
    }),
    [
      threadId,
      onComposeFeedback,
      getDiffReviewPosition,
      setDiffReviewPosition,
      getArtifactReviewPosition,
      setArtifactReviewPosition,
    ],
  );

  return (
    <ChatReviewFeedbackContext.Provider value={value}>
      {children}
    </ChatReviewFeedbackContext.Provider>
  );
}

export function useChatReviewFeedback(): ChatReviewFeedbackContextValue | null {
  return useContext(ChatReviewFeedbackContext);
}
