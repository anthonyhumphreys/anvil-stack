import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { companionColors } from '@/components/companion-ui';
import { CompanionProvider } from '@/contexts/companion-context';
import { useColorScheme } from '@/hooks/use-color-scheme';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <CompanionProvider>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="thread"
            options={{
              title: 'Thread',
              headerLargeTitle: false,
              headerBackButtonDisplayMode: 'minimal',
              contentStyle: { backgroundColor: companionColors.screen },
            }}
          />
          <Stack.Screen
            name="new-task"
            options={{
              title: 'New task',
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              sheetAllowedDetents: [0.75, 1],
            }}
          />
        </Stack>
        <StatusBar style="auto" />
      </CompanionProvider>
    </ThemeProvider>
  );
}
