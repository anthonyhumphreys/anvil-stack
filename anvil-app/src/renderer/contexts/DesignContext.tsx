import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DesignMode, DesignReadiness, FigmaFileRef } from '../../shared/types';
import { extractFigmaRefs } from '../utils/figma-url';
import { loadDesignModePreference, storeDesignModePreference } from '../utils/design-mode';
import { useChatContext } from './ChatContext';

interface DesignContextValue {
  mode: DesignMode;
  figmaFiles: FigmaFileRef[];
  activeFigmaFile: FigmaFileRef | null;
  readiness: DesignReadiness | null;
  readinessLoading: boolean;
  switchMode: (mode: DesignMode) => Promise<void>;
  setActiveFigmaFile: (ref: FigmaFileRef) => void;
  processMessageForFigmaUrls: (text: string) => void;
  resolveReadinessIssue: (issue: 'figmaMcp' | 'frontendSkill') => Promise<void>;
  recheckReadiness: () => Promise<void>;
}

const DesignContext = createContext<DesignContextValue | null>(null);

export function useDesign(): DesignContextValue {
  const ctx = useContext(DesignContext);
  if (!ctx) throw new Error('useDesign must be used within <DesignProvider>');
  return ctx;
}

export function DesignProvider({ children }: { children: ReactNode }) {
  const { session, activeRepos, entries } = useChatContext();
  const [mode, setMode] = useState<DesignMode>(() => loadDesignModePreference());
  const [figmaFiles, setFigmaFiles] = useState<FigmaFileRef[]>([]);
  const [activeFigmaFile, setActiveFigmaFile] = useState<FigmaFileRef | null>(null);
  const [readiness, setReadiness] = useState<DesignReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);

  const checkReadiness = useCallback(async () => {
    setReadinessLoading(true);
    try {
      const result = await window.anvil.design.checkReadiness();
      setReadiness(result);
    } catch (err) {
      console.error('Failed to check design readiness:', err);
    } finally {
      setReadinessLoading(false);
    }
  }, []);

  // Check readiness on mount
  useEffect(() => {
    checkReadiness();
  }, [checkReadiness]);

  const switchMode = useCallback(
    async (newMode: DesignMode) => {
      if (newMode === mode) return;
      setMode(newMode);
      storeDesignModePreference(newMode);

      // Restart session with new mode if we have an active session
      if (session && activeRepos.length > 0) {
        try {
          await window.anvil.chat.stopSession(session.id);
        } catch {
          /* already stopped */
        }

        try {
          await window.anvil.chat.startSession(
            activeRepos.map((r) => r.id),
            'design',
            { designMode: newMode },
          );
        } catch (err) {
          console.error('Failed to restart session with new mode:', err);
        }
      }
    },
    [mode, session, activeRepos],
  );

  const processMessageForFigmaUrls = useCallback((text: string) => {
    const refs = extractFigmaRefs(text);
    if (refs.length === 0) return;

    setFigmaFiles((prev) => {
      const existing = new Set(prev.map((f) => `${f.kind}:${f.fileKey}`));
      const newRefs = refs.filter((r) => !existing.has(`${r.kind}:${r.fileKey}`));
      return [...newRefs, ...prev];
    });

    // Set the first new ref as active
    setActiveFigmaFile(refs[0]);
  }, []);

  // Watch for new user messages containing Figma URLs
  const processedCountRef = useRef(0);

  useEffect(() => {
    const newEntries = entries.slice(processedCountRef.current);
    processedCountRef.current = entries.length;

    for (const entry of newEntries) {
      if (entry.kind === 'user') {
        processMessageForFigmaUrls(entry.content);
      }
    }
  }, [entries, processMessageForFigmaUrls]);

  const resolveReadinessIssue = useCallback(
    async (issue: 'figmaMcp' | 'frontendSkill') => {
      try {
        if (issue === 'figmaMcp') {
          await window.anvil.design.registerFigmaMcp();
        } else {
          await window.anvil.design.installFrontendSkill();
        }
        // Re-check readiness after install
        await checkReadiness();
      } catch (err) {
        console.error(`Failed to resolve readiness issue (${issue}):`, err);
      }
    },
    [checkReadiness],
  );

  return (
    <DesignContext.Provider
      value={{
        mode,
        figmaFiles,
        activeFigmaFile,
        readiness,
        readinessLoading,
        switchMode,
        setActiveFigmaFile,
        processMessageForFigmaUrls,
        resolveReadinessIssue,
        recheckReadiness: checkReadiness,
      }}
    >
      {children}
    </DesignContext.Provider>
  );
}
