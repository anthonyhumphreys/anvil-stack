import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Tabs, router } from 'expo-router';
import { Pressable, useColorScheme } from 'react-native';
import { HapticTab } from '@/components/haptic-tab';
import { companionColors } from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';

export default function TabLayout() {
  const dark = useColorScheme() === 'dark';
  const { overview } = useCompanion();
  const inboxCount =
    (overview?.pendingApprovals.length ?? 0) +
    (overview?.activeSessions.filter((session) => session.status === 'error').length ?? 0);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: dark ? '#f4f7fb' : '#111722',
        tabBarInactiveTintColor: dark ? '#98a6b8' : '#687386',
        tabBarButton: HapticTab,
        headerShadowVisible: false,
        headerStyle: { backgroundColor: companionColors.screen },
        headerTitleStyle: { fontWeight: '900' },
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
              marginRight: 6,
            }}
          >
            <MaterialIcons name="settings" size={22} color={companionColors.ink} />
          </Pressable>
        ),
        tabBarStyle: {
          backgroundColor: companionColors.surface,
          borderTopColor: companionColors.borderSubtle,
          height: 82,
          paddingTop: 7,
          paddingBottom: 19,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '800' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Work',
          tabBarIcon: ({ color }) => <MaterialIcons size={24} name="work-outline" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Threads',
          headerShown: false,
          tabBarIcon: ({ color }) => <MaterialIcons size={24} name="forum" color={color} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Inbox',
          tabBarBadge: inboxCount > 0 ? (inboxCount > 99 ? '99+' : inboxCount) : undefined,
          tabBarIcon: ({ color }) => <MaterialIcons size={24} name="inbox" color={color} />,
        }}
      />
      <Tabs.Screen name="work" options={{ href: null }} />
      <Tabs.Screen name="health" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="settings" options={{ href: null, title: 'Settings' }} />
    </Tabs>
  );
}
