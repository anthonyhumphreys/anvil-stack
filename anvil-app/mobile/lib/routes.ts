import {
  useNavigation,
  type NativeStackNavigationProp,
  type RelativePathString,
} from 'expo-router';
import { useCallback } from 'react';

type RootStackParamList = {
  '(tabs)': undefined;
  thread: { threadId: string };
  'new-task': undefined;
};

export function threadHref(threadId: string): RelativePathString {
  return `/thread?threadId=${encodeURIComponent(threadId)}` as RelativePathString;
}

export function useOpenThread(): (threadId: string) => void {
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>('/');

  return useCallback(
    (threadId: string) => rootNavigation.push('thread', { threadId }),
    [rootNavigation],
  );
}
