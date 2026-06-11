import type { ReactNode } from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

export const companionColors = {
  screen: '#f5f7fb',
  surface: '#ffffff',
  surfaceMuted: '#f8fafc',
  ink: '#101828',
  muted: '#475467',
  subtle: '#667085',
  faint: '#98a2b3',
  border: '#d0d5dd',
  borderSubtle: '#eaecf0',
  accent: '#f79009',
  accentInk: '#7a2e0e',
  accentSoft: '#fff7ed',
  dark: '#111827',
  darkMuted: '#d0d5dd',
  blue: '#175cd3',
  blueSoft: '#eff8ff',
  green: '#067647',
  greenSoft: '#ecfdf3',
  red: '#b42318',
  redSoft: '#fff1f0',
  purple: '#5925dc',
  purpleSoft: '#f4f3ff',
};

export function ScreenHeader({
  eyebrow,
  title,
  detail,
  right,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  right?: ReactNode;
}) {
  return (
    <View style={headerStyle}>
      <View style={{ flex: 1, gap: 5 }}>
        {eyebrow && <Text style={eyebrowStyle}>{eyebrow}</Text>}
        <Text style={screenTitleStyle}>{title}</Text>
        {detail && <Text style={bodyStyle}>{detail}</Text>}
      </View>
      {right}
    </View>
  );
}

export function Panel({
  children,
  tone = 'default',
  style,
}: {
  children: ReactNode;
  tone?: 'default' | 'dark' | 'warning' | 'danger';
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[panelBaseStyle, panelToneStyles[tone], style]}>{children}</View>;
}

export function SectionHeader({
  title,
  count,
  detail,
}: {
  title: string;
  count?: number;
  detail?: string;
}) {
  return (
    <View style={sectionHeaderStyle}>
      <View style={{ flex: 1 }}>
        <Text style={sectionTitleStyle}>{title}</Text>
        {detail && <Text style={subtleStyle}>{detail}</Text>}
      </View>
      {typeof count === 'number' && (
        <View style={countPillStyle}>
          <Text style={countPillTextStyle}>{count}</Text>
        </View>
      )}
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={emptyStateStyle}>
      <Text style={titleStyle}>{title}</Text>
      <Text style={bodyStyle}>{body}</Text>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  variant = 'primary',
  disabled,
  style,
  textStyle,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'success';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <TouchableOpacity
      disabled={disabled}
      onPress={onPress}
      style={[buttonBaseStyle, buttonStyles[variant], disabled && disabledStyle, style]}
    >
      <Text style={[buttonTextStyles[variant], textStyle]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function StatusPill({
  label,
  color,
  background,
}: {
  label: string;
  color: string;
  background: string;
}) {
  return (
    <View style={[statusPillStyle, { backgroundColor: background }]}>
      <Text style={{ color, fontWeight: '800', fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export const screenStyle = { backgroundColor: companionColors.screen };
export const scrollContentStyle = { padding: 20, gap: 16, paddingBottom: 36 };
export const titleStyle = {
  color: companionColors.ink,
  fontSize: 17,
  fontWeight: '900' as const,
};
export const bodyStyle = {
  color: companionColors.muted,
  fontSize: 14,
  lineHeight: 20,
};
export const subtleStyle = {
  color: companionColors.subtle,
  fontSize: 13,
  lineHeight: 19,
};
export const inputStyle = {
  borderColor: companionColors.border,
  borderWidth: 1,
  borderRadius: 10,
  padding: 12,
  color: companionColors.ink,
  backgroundColor: companionColors.surface,
};

const headerStyle = {
  flexDirection: 'row' as const,
  justifyContent: 'space-between' as const,
  gap: 12,
  alignItems: 'flex-start' as const,
};
const screenTitleStyle = {
  color: companionColors.ink,
  fontSize: 30,
  fontWeight: '900' as const,
  letterSpacing: 0,
};
const eyebrowStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '800' as const,
  letterSpacing: 0,
};
const panelBaseStyle = {
  borderWidth: 1,
  borderRadius: 10,
  padding: 14,
  gap: 10,
};
const panelToneStyles = {
  default: {
    backgroundColor: companionColors.surface,
    borderColor: companionColors.borderSubtle,
  },
  dark: {
    backgroundColor: companionColors.dark,
    borderColor: companionColors.dark,
  },
  warning: {
    backgroundColor: companionColors.accentSoft,
    borderColor: '#fedf89',
  },
  danger: {
    backgroundColor: companionColors.redSoft,
    borderColor: '#fecdca',
  },
};
const sectionHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'space-between' as const,
  gap: 12,
};
const sectionTitleStyle = {
  color: companionColors.ink,
  fontSize: 18,
  fontWeight: '900' as const,
};
const countPillStyle = {
  minWidth: 30,
  alignItems: 'center' as const,
  borderRadius: 999,
  paddingHorizontal: 9,
  paddingVertical: 5,
  backgroundColor: companionColors.surface,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
};
const countPillTextStyle = {
  color: companionColors.subtle,
  fontSize: 13,
  fontWeight: '900' as const,
};
const emptyStateStyle = {
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  borderRadius: 10,
  padding: 14,
  gap: 4,
  backgroundColor: companionColors.surfaceMuted,
};
const buttonBaseStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  borderRadius: 10,
  paddingHorizontal: 14,
  paddingVertical: 12,
  borderWidth: 1,
};
const buttonStyles = {
  primary: {
    backgroundColor: companionColors.dark,
    borderColor: companionColors.dark,
  },
  secondary: {
    backgroundColor: companionColors.surface,
    borderColor: companionColors.border,
  },
  danger: {
    backgroundColor: companionColors.redSoft,
    borderColor: '#fecdca',
  },
  success: {
    backgroundColor: companionColors.green,
    borderColor: companionColors.green,
  },
};
const buttonTextStyles = {
  primary: { color: '#fcfcfd', fontSize: 15, fontWeight: '900' as const },
  secondary: { color: companionColors.ink, fontSize: 15, fontWeight: '800' as const },
  danger: { color: companionColors.red, fontSize: 15, fontWeight: '900' as const },
  success: { color: '#fcfcfd', fontSize: 15, fontWeight: '900' as const },
};
const disabledStyle = { opacity: 0.46 };
const statusPillStyle = {
  alignSelf: 'flex-start' as const,
  borderRadius: 999,
  paddingHorizontal: 10,
  paddingVertical: 7,
};
