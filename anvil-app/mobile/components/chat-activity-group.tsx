import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { useState, type ComponentProps } from 'react';
import { Text, TouchableOpacity, View, type TextStyle } from 'react-native';
import { companionColors } from '@/components/companion-ui';
import type { ChatMessage, CodexEvent } from '../../src/shared/types';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

export function ChatActivityGroup({ messages }: { messages: ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeActivity(messages);
  const preview = describeActivity(messages[messages.length - 1]);
  const hasError = messages.some(
    (message) =>
      message.event?.type === 'error' ||
      (message.event?.type === 'command_exec' && (message.event.exitCode ?? 0) !== 0),
  );

  return (
    <View style={[activityGroupStyle, hasError && activityGroupErrorStyle]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse activity details' : 'Expand activity details'}
        accessibilityState={{ expanded }}
        activeOpacity={0.72}
        onPress={() => setExpanded((current) => !current)}
        style={activityGroupHeaderStyle}
      >
        <MaterialIcons
          name={expanded ? 'keyboard-arrow-down' : 'keyboard-arrow-right'}
          size={18}
          color={companionColors.subtle}
        />
        <MaterialIcons
          name={hasError ? 'error-outline' : 'build'}
          size={16}
          color={hasError ? companionColors.red : companionColors.subtle}
        />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={activityTitleRowStyle}>
            <Text style={activityTitleStyle}>Activity</Text>
            <Text numberOfLines={1} style={activitySummaryStyle}>
              {summary}
            </Text>
          </View>
          {!expanded && (
            <Text numberOfLines={1} style={activityPreviewStyle}>
              {preview}
            </Text>
          )}
        </View>
        <Text style={timeStyle}>{relativeTime(messages[messages.length - 1].timestamp)}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={activityDetailListStyle}>
          {messages.map((message) => (
            <ActivityDetail key={message.id} message={message} />
          ))}
        </View>
      )}
    </View>
  );
}

function ActivityDetail({ message }: { message: ChatMessage }) {
  const event = message.event;
  const detail = activityDetail(event, message.content);
  return (
    <View style={activityDetailStyle}>
      <View style={activityDetailHeaderStyle}>
        <MaterialIcons name={activityIcon(event)} size={15} color={activityColor(event)} />
        <Text style={activityDetailTitleStyle}>{describeActivity(message)}</Text>
        <Text style={timeStyle}>{relativeTime(message.timestamp)}</Text>
      </View>
      {detail ? (
        <Text selectable style={activityDetailTextStyle}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

function summarizeActivity(messages: ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const label = activityCountLabel(message.event);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const breakdown = [...counts.entries()]
    .slice(0, 3)
    .map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`)
    .join(' · ');
  return `${messages.length} item${messages.length === 1 ? '' : 's'}${breakdown ? ` · ${breakdown}` : ''}`;
}

function activityCountLabel(event: CodexEvent | undefined): string {
  switch (event?.type) {
    case 'command_exec':
      return 'command';
    case 'file_edit':
      return 'edit';
    case 'file_read':
      return 'read';
    case 'thinking':
      return 'reasoning';
    case 'error':
      return 'error';
    default:
      return 'tool';
  }
}

function describeActivity(message: ChatMessage): string {
  const event = message.event;
  switch (event?.type) {
    case 'command_exec':
      return event.command?.trim() || 'Command';
    case 'file_edit':
      return event.filePath ? `Edited ${event.filePath}` : 'File edited';
    case 'file_read':
      return event.filePath ? `Read ${event.filePath}` : 'File read';
    case 'tool_call':
      return event.toolName ? `Used ${event.toolName}` : 'Tool call';
    case 'thinking':
      return 'Reasoning';
    case 'approval_request':
      return 'Approval requested';
    case 'plan_update':
      return 'Plan updated';
    case 'goal_update':
      return 'Goal updated';
    case 'goal_cleared':
      return 'Goal cleared';
    case 'error':
      return event.errorMessage || 'Error';
    case 'status':
      return event.status ? `Status: ${event.status}` : 'Status updated';
    default:
      return message.content.replace(/\s+/g, ' ').trim() || 'Activity';
  }
}

function activityDetail(event: CodexEvent | undefined, fallback: string): string {
  if (!event) return fallback;
  switch (event.type) {
    case 'command_exec':
      return [event.command, event.output].filter(Boolean).join('\n\n');
    case 'file_edit':
      return event.diff || event.filePath || fallback;
    case 'file_read':
      return event.lineRange
        ? `${event.filePath ?? fallback}:${event.lineRange[0]}-${event.lineRange[1]}`
        : event.filePath || fallback;
    case 'tool_call':
      return event.toolInput ? JSON.stringify(event.toolInput, null, 2) : fallback;
    case 'thinking':
    case 'text':
      return event.text || fallback;
    case 'error':
      return event.errorMessage || fallback;
    default:
      return fallback;
  }
}

function activityIcon(event: CodexEvent | undefined): IconName {
  switch (event?.type) {
    case 'command_exec':
      return 'terminal';
    case 'file_edit':
      return 'edit';
    case 'file_read':
      return 'description';
    case 'thinking':
      return 'auto-awesome';
    case 'error':
      return 'error-outline';
    case 'approval_request':
      return 'priority-high';
    default:
      return 'build';
  }
}

function activityColor(event: CodexEvent | undefined) {
  if (event?.type === 'error') return companionColors.red;
  if (event?.type === 'file_edit' || event?.type === 'file_read') return companionColors.blue;
  if (event?.type === 'thinking') return companionColors.accent;
  return companionColors.subtle;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'recently';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}h ago`;
  return `${Math.max(1, Math.floor(diff / 86_400_000))}d ago`;
}

const activityGroupStyle = {
  alignSelf: 'stretch' as const,
  overflow: 'hidden' as const,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 10,
  borderCurve: 'continuous' as const,
  backgroundColor: companionColors.surfaceMuted,
};
const activityGroupErrorStyle = { borderColor: companionColors.redBorder };
const activityGroupHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 8,
  paddingHorizontal: 11,
  paddingVertical: 10,
};
const activityTitleRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 7,
};
const activityTitleStyle = {
  color: companionColors.muted,
  fontWeight: '900' as const,
  fontSize: 13,
};
const activitySummaryStyle = { flex: 1, color: companionColors.subtle, fontSize: 12 };
const activityPreviewStyle = { color: companionColors.faint, fontSize: 12, lineHeight: 16 };
const activityDetailListStyle = {
  borderTopColor: companionColors.borderSubtle,
  borderTopWidth: 1,
  padding: 8,
  gap: 7,
};
const activityDetailStyle = {
  gap: 7,
  padding: 9,
  borderRadius: 8,
  borderCurve: 'continuous' as const,
  backgroundColor: companionColors.surface,
};
const activityDetailHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 7,
};
const activityDetailTitleStyle = {
  flex: 1,
  color: companionColors.muted,
  fontSize: 12,
  fontWeight: '800' as const,
};
const activityDetailTextStyle = {
  color: companionColors.subtle,
  fontFamily: 'Menlo',
  fontSize: 12,
  lineHeight: 17,
};
const timeStyle = {
  color: companionColors.faint,
  fontSize: 12,
  fontVariant: ['tabular-nums'],
} satisfies TextStyle;
