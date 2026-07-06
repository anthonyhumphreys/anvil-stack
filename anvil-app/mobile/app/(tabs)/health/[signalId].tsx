import { Stack, useLocalSearchParams } from 'expo-router';
import { WorkspaceSignalDetail } from '@/components/workspace-signal-detail';

export default function HealthSignalScreen() {
  const { signalId } = useLocalSearchParams<{ signalId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Signal' }} />
      <WorkspaceSignalDetail signalId={signalId} />
    </>
  );
}
