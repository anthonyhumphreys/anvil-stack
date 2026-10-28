import { Stack } from 'expo-router';
import { companionColors } from '@/components/companion-ui';

export default function HealthLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: false,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: companionColors.screen },
      }}
    >
      <Stack.Screen name="[signalId]" options={{ title: 'Signal' }} />
    </Stack>
  );
}
