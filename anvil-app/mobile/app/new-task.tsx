import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ActionButton, companionColors, inputStyle, screenStyle } from '@/components/companion-ui';
import { WorkspaceBar } from '@/components/workspace-bar';
import { useCompanion } from '@/contexts/companion-context';
import { threadHref } from '@/lib/routes';
import type { ChatCollaborationMode, ReasoningEffort } from '../../src/shared/types';

export default function NewTaskScreen() {
  const { overview, startWorkflow, error } = useCompanion();
  const [draft, setDraft] = useState('');
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [mode, setMode] = useState<ChatCollaborationMode>('plan');
  const [reasoning, setReasoning] = useState<ReasoningEffort>('medium');
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const workspace = overview?.activeWorkspace;
  const repos = useMemo(() => workspace?.repos ?? [], [workspace]);
  const effectiveRepoIds =
    selectedRepoIds.length > 0 ? selectedRepoIds : repos.map((repo) => repo.id);

  const submit = async () => {
    const message = draft.trim();
    if (!message || !workspace || effectiveRepoIds.length === 0) return;
    setSubmitting(true);
    try {
      const result = await startWorkflow({
        message,
        workspaceId: workspace.id,
        repoIds: effectiveRepoIds,
        collaborationMode: mode,
        reasoningEffort: reasoning,
      });
      if (!result) return;
      setDraft('');
      router.replace(threadHref(result.thread.id));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}
      style={[screenStyle, { flex: 1 }]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 34 }}
      >
        <WorkspaceBar />
        <View style={{ gap: 8 }}>
          <Text style={labelStyle}>What should Anvil do?</Text>
          <TextInput
            accessibilityLabel="Task instructions"
            value={draft}
            onChangeText={setDraft}
            placeholder="Review the failing build and fix the root cause"
            placeholderTextColor={companionColors.faint}
            multiline
            autoFocus
            style={[
              inputStyle,
              { minHeight: 132, textAlignVertical: 'top', fontSize: 16, lineHeight: 23 },
            ]}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text style={labelStyle}>Repositories</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {repos.map((repo) => {
              const selected = selectedRepoIds.length === 0 || selectedRepoIds.includes(repo.id);
              return (
                <Pressable
                  key={repo.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  onPress={() =>
                    setSelectedRepoIds((current) => {
                      const base = current.length === 0 ? repos.map((item) => item.id) : current;
                      return base.includes(repo.id)
                        ? base.filter((id) => id !== repo.id)
                        : [...base, repo.id];
                    })
                  }
                  style={{
                    minHeight: 44,
                    paddingHorizontal: 13,
                    borderRadius: 12,
                    borderCurve: 'continuous',
                    justifyContent: 'center',
                    backgroundColor: selected
                      ? companionColors.accentSoft
                      : companionColors.surface,
                    borderWidth: 1,
                    borderColor: selected ? companionColors.accent : companionColors.borderSubtle,
                  }}
                >
                  <Text
                    style={{
                      color: selected ? companionColors.accentInk : companionColors.muted,
                      fontWeight: '700',
                    }}
                  >
                    {repo.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: advanced }}
          onPress={() => setAdvanced((value) => !value)}
          style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 }}
        >
          <MaterialIcons
            name={advanced ? 'expand-less' : 'expand-more'}
            size={22}
            color={companionColors.subtle}
          />
          <Text style={{ color: companionColors.muted, fontWeight: '700' }}>Advanced options</Text>
        </Pressable>

        {advanced && (
          <View style={{ gap: 14 }}>
            <ChoiceRow
              label="Mode"
              values={[
                ['Plan first', 'plan'],
                ['Execute', 'default'],
              ]}
              selected={mode}
              onSelect={(value) => setMode(value as ChatCollaborationMode)}
            />
            <ChoiceRow
              label="Reasoning"
              values={[
                ['Low', 'low'],
                ['Medium', 'medium'],
                ['High', 'high'],
              ]}
              selected={reasoning}
              onSelect={(value) => setReasoning(value as ReasoningEffort)}
            />
          </View>
        )}

        {error && (
          <Text
            accessibilityLiveRegion="polite"
            selectable
            style={{ color: companionColors.red, fontSize: 14 }}
          >
            {error}
          </Text>
        )}
        <ActionButton
          label={submitting ? 'Starting…' : 'Start task'}
          disabled={submitting || !draft.trim() || !workspace || effectiveRepoIds.length === 0}
          onPress={() => void submit()}
          style={{ minHeight: 52 }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ChoiceRow({
  label,
  values,
  selected,
  onSelect,
}: {
  label: string;
  values: [string, string][];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={labelStyle}>{label}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {values.map(([title, value]) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ selected: selected === value }}
            onPress={() => onSelect(value)}
            style={{
              minHeight: 44,
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 11,
              backgroundColor:
                selected === value ? companionColors.accentSoft : companionColors.surface,
              borderWidth: 1,
              borderColor:
                selected === value ? companionColors.accent : companionColors.borderSubtle,
            }}
          >
            <Text
              style={{
                color: selected === value ? companionColors.accentInk : companionColors.muted,
                fontWeight: '700',
              }}
            >
              {title}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const labelStyle = { color: companionColors.ink, fontSize: 14, fontWeight: '800' as const };
