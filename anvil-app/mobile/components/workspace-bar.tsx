import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useCompanion } from '@/contexts/companion-context';
import { companionColors } from '@/components/companion-ui';

export function WorkspaceBar() {
  const { connection, overview, selectWorkspace, usingCachedOverview } = useCompanion();
  const [expanded, setExpanded] = useState(false);
  const workspace = overview?.activeWorkspace;

  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Select workspace"
        accessibilityHint="Shows workspaces available on the current Mac"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({
          minHeight: 48,
          paddingHorizontal: 14,
          paddingVertical: 9,
          borderRadius: 14,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: companionColors.borderSubtle,
          backgroundColor: pressed ? companionColors.surfaceMuted : companionColors.surface,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        })}
      >
        <MaterialIcons name="computer" size={20} color={companionColors.subtle} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ color: companionColors.ink, fontSize: 15, fontWeight: '800' }}
          >
            {workspace?.name ?? 'Choose a workspace'}
          </Text>
          <Text numberOfLines={1} style={{ color: companionColors.subtle, fontSize: 12 }}>
            {connection?.deviceName ?? 'No host'}
            {usingCachedOverview ? ' · Offline snapshot' : ''}
          </Text>
        </View>
        <MaterialIcons
          name={expanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
          size={22}
          color={companionColors.subtle}
        />
      </Pressable>

      {expanded && (
        <View
          accessibilityRole="menu"
          style={{
            borderRadius: 14,
            borderCurve: 'continuous',
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: companionColors.borderSubtle,
            backgroundColor: companionColors.surface,
          }}
        >
          {(overview?.workspaces ?? []).map((candidate) => {
            const selected = candidate.id === workspace?.id;
            return (
              <Pressable
                key={candidate.id}
                accessibilityRole="menuitem"
                accessibilityLabel={`${candidate.name}, ${candidate.repoCount} repositories`}
                accessibilityState={{ selected }}
                onPress={() => {
                  setExpanded(false);
                  void selectWorkspace(candidate.id);
                }}
                style={({ pressed }) => ({
                  minHeight: 52,
                  paddingHorizontal: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  backgroundColor: selected
                    ? companionColors.accentSoft
                    : pressed
                      ? companionColors.surfaceMuted
                      : companionColors.surface,
                })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: companionColors.ink, fontSize: 15, fontWeight: '700' }}>
                    {candidate.name}
                  </Text>
                  <Text style={{ color: companionColors.subtle, fontSize: 12 }}>
                    {candidate.repoCount}{' '}
                    {candidate.repoCount === 1 ? 'repository' : 'repositories'}
                  </Text>
                </View>
                {selected && (
                  <MaterialIcons name="check" size={20} color={companionColors.accentInk} />
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}
