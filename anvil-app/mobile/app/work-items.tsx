import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { router, type RelativePathString } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, FlatList, Text, TextInput, Pressable, View } from 'react-native';
import {
  EmptyState,
  SectionHeader,
  companionColors,
  inputStyle,
  screenStyle,
  scrollContentStyle,
} from '@/components/companion-ui';
import { WorkspaceBar } from '@/components/workspace-bar';
import { useCompanion } from '@/contexts/companion-context';

export default function WorkItemsScreen() {
  const { overview, loading, refresh } = useCompanion();
  const [workQuery, setWorkQuery] = useState('');
  const [showAllWorkItems, setShowAllWorkItems] = useState(false);
  const currentIteration = overview?.currentIterationPath;
  const visibleWorkItems = useMemo(() => {
    const query = workQuery.trim().toLowerCase();
    return (overview?.workItems ?? [])
      .filter(
        (item) => showAllWorkItems || !currentIteration || item.iterationPath === currentIteration,
      )
      .filter(
        (item) =>
          !query ||
          `${item.id} ${item.title} ${item.state ?? ''} ${item.assignee ?? ''} ${item.iterationPath ?? ''}`
            .toLowerCase()
            .includes(query),
      );
  }, [currentIteration, overview?.workItems, showAllWorkItems, workQuery]);

  return (
    <FlatList
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
      contentContainerStyle={[
        scrollContentStyle,
        { width: '100%', maxWidth: 760, alignSelf: 'center' },
      ]}
      data={visibleWorkItems}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View style={{ gap: 20, paddingBottom: 8 }}>
          <WorkspaceBar />
          <View style={{ gap: 12 }}>
            <SectionHeader
              title={showAllWorkItems || !currentIteration ? 'All open work' : 'Current sprint'}
              detail={!showAllWorkItems ? currentIteration : undefined}
              count={visibleWorkItems.length}
            />
            <TextInput
              accessibilityLabel="Search work items"
              value={workQuery}
              onChangeText={setWorkQuery}
              placeholder="Search ID, title, state, or assignee"
              placeholderTextColor={companionColors.subtle}
              returnKeyType="search"
              style={[inputStyle, { minHeight: 48 }]}
            />
            {currentIteration && (
              <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>
                <ScopeButton
                  title="Current sprint"
                  selected={!showAllWorkItems}
                  onPress={() => setShowAllWorkItems(false)}
                />
                <ScopeButton
                  title="All open"
                  selected={showAllWorkItems}
                  onPress={() => setShowAllWorkItems(true)}
                />
              </View>
            )}
          </View>
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          title={workQuery ? 'No matching work' : 'No open work items'}
          body={
            workQuery
              ? 'Try a broader search or switch to all open work.'
              : 'Synced work appears here.'
          }
        />
      }
      renderItem={({ item }) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          onPress={() =>
            router.push(
              `/(tabs)/health/work-item:${encodeURIComponent(item.id)}` as RelativePathString,
            )
          }
          style={rowStyle}
        >
          <View style={{ minWidth: 54 }}>
            <Text
              numberOfLines={1}
              style={{ color: companionColors.accentInk, fontSize: 12, fontWeight: '600' }}
            >
              {item.id}
            </Text>
            <Text numberOfLines={1} style={{ color: companionColors.subtle, fontSize: 11 }}>
              {item.state ?? 'Open'}
            </Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={2} style={rowTitleStyle}>
              {item.title}
            </Text>
            <Text numberOfLines={1} style={rowDetailStyle}>
              {[item.type, item.assignee].filter(Boolean).join(' · ') ||
                item.iterationPath ||
                'Tracked work'}
            </Text>
          </View>
          <MaterialIcons name="chevron-right" size={22} color={companionColors.faint} />
        </Pressable>
      )}
    />
  );
}

function ScopeButton({
  title,
  selected,
  onPress,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: 48,
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 11,
        borderCurve: 'continuous',
        backgroundColor: selected ? companionColors.accentSoft : companionColors.surfaceMuted,
      }}
    >
      <Text
        style={{
          color: selected ? companionColors.accentInk : companionColors.subtle,
          fontSize: 13,
          fontWeight: '600',
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

const rowStyle = ({ pressed }: { pressed: boolean }) => ({
  minHeight: 62,
  paddingHorizontal: 14,
  paddingVertical: 10,
  borderRadius: 14,
  borderCurve: 'continuous' as const,
  backgroundColor: pressed ? companionColors.surfaceMuted : companionColors.surface,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 11,
});
const rowTitleStyle = { color: companionColors.ink, fontSize: 15, fontWeight: '600' as const };
const rowDetailStyle = { color: companionColors.subtle, fontSize: 13, lineHeight: 18 };
