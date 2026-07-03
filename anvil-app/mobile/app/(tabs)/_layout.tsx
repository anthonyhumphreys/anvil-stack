import { Tabs } from 'expo-router';
import React from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: false,
        tabBarButton: HapticTab,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Work',
          tabBarIcon: ({ color }) => <MaterialIcons size={24} name="workspaces" color={color} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Approvals',
          tabBarIcon: ({ color }) => <MaterialIcons size={24} name="verified" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color }) => <MaterialIcons size={24} name="chat" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => (
            <MaterialIcons size={24} name="qr-code-scanner" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
