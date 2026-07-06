import { Stack } from 'expo-router';
import { companionColors } from '@/components/companion-ui';

export default function ChatsLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: companionColors.screen },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Chats' }} />
      <Stack.Screen
        name="[threadId]"
        options={{
          headerLargeTitle: false,
          title: 'Thread',
        }}
      />
    </Stack>
  );
}
