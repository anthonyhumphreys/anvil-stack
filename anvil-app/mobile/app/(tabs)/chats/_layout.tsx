import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, router } from 'expo-router';
import { Pressable } from 'react-native';
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
      <Stack.Screen
        name="index"
        options={{
          title: 'Threads',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              hitSlop={10}
              onPress={() => router.push('/(tabs)/settings')}
              style={{
                minWidth: 44,
                minHeight: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MaterialIcons name="settings" size={22} color={companionColors.ink} />
            </Pressable>
          ),
        }}
      />
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
