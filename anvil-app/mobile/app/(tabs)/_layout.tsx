import { Badge, Icon, Label } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEffect } from 'react';
import { DynamicColorIOS, Platform } from 'react-native';
import { useCompanion } from '@/contexts/companion-context';
import { useOpenThread } from '@/lib/routes';

export default function TabLayout() {
  const { overview, pendingThreadId, consumePendingThread } = useCompanion();
  const openThread = useOpenThread();
  const inboxCount =
    (overview?.pendingApprovals.length ?? 0) +
    (overview?.activeSessions.filter((session) => session.status === 'error').length ?? 0);

  useEffect(() => {
    if (!pendingThreadId) return;
    openThread(pendingThreadId);
    consumePendingThread();
  }, [consumePendingThread, openThread, pendingThreadId]);

  return (
    <NativeTabs tintColor={nativeTint}>
      <NativeTabs.Trigger name="index">
        <Label>Work</Label>
        <Icon sf={{ default: 'hammer', selected: 'hammer.fill' }} md="work" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chats">
        <Label>Threads</Label>
        <Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
          md="forum"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="approvals">
        <Label>Inbox</Label>
        <Icon sf={{ default: 'tray', selected: 'tray.fill' }} md="inbox" />
        <Badge hidden={inboxCount === 0}>{inboxCount > 99 ? '99+' : String(inboxCount)}</Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <Label>Settings</Label>
        <Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} md="settings" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="work" hidden />
      <NativeTabs.Trigger name="health" hidden />
    </NativeTabs>
  );
}

const nativeTint =
  Platform.OS === 'ios' ? DynamicColorIOS({ light: '#9a5b08', dark: '#fbbf24' }) : '#b56b08';
