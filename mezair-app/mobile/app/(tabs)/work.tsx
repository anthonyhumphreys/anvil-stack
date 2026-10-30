import { Stack } from 'expo-router';
import { WorkspaceHealthBoard } from '@/components/workspace-health-board';

export default function WorkRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Work' }} />
      <WorkspaceHealthBoard />
    </>
  );
}
