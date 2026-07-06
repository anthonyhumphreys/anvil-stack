import { Tabs } from 'expo-router';
import React from 'react';
import { useColorScheme } from 'react-native';

import { HapticTab } from '@/components/haptic-tab';
import { companionColors } from '@/components/companion-ui';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

export default function TabLayout() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: dark ? '#f4f7fb' : '#111722',
        tabBarInactiveTintColor: dark ? '#98a6b8' : '#687386',
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: {
          backgroundColor: companionColors.surface,
          borderTopColor: companionColors.borderSubtle,
          height: 86,
          paddingTop: 8,
          paddingBottom: 22,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '800',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
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
        name="work"
        options={{
          title: 'Work',
          tabBarIcon: ({ color }) => <MaterialIcons size={24} name="assignment" color={color} />,
        }}
      />
      <Tabs.Screen
        name="health"
        options={{
          href: null,
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
