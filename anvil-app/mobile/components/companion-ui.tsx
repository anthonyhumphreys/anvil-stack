import type { ReactNode } from 'react';
import * as Haptics from 'expo-haptics';
import {
  Appearance,
  DynamicColorIOS,
  Platform,
  Text,
  TouchableOpacity,
  View,
  type ColorValue,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

export type CompanionColor = ColorValue;

const dynamicColor = (light: string, dark: string): CompanionColor =>
  Platform.OS === 'ios'
    ? DynamicColorIOS({ light, dark })
    : Appearance.getColorScheme() === 'dark'
      ? dark
      : light;

export const companionColors = {
  screen: dynamicColor('#f3f5f8', '#0f141c'),
  surface: dynamicColor('#fbfcfe', '#171d27'),
  surfaceMuted: dynamicColor('#f2f5f9', '#202836'),
  ink: dynamicColor('#111722', '#f4f7fb'),
  muted: dynamicColor('#405064', '#c4cedb'),
  subtle: dynamicColor('#687386', '#98a6b8'),
  faint: dynamicColor('#98a2b3', '#748195'),
  border: dynamicColor('#cbd3df', '#3b4657'),
  borderSubtle: dynamicColor('#e1e7f0', '#283242'),
  accent: dynamicColor('#f59e0b', '#fbbf24'),
  accentInk: dynamicColor('#78350f', '#facc15'),
  accentSoft: dynamicColor('#fff7ed', '#332512'),
  dark: '#101621',
  darkRaised: '#1b2534',
  darkMuted: '#ccd6e3',
  darkBorder: '#475467',
  darkControl: '#1d2939',
  darkControlActive: '#344054',
  darkIconSurface: '#1f2937',
  onDark: '#fcfcfd',
  blue: dynamicColor('#1d4ed8', '#7db1ff'),
  blueSoft: dynamicColor('#edf5ff', '#142238'),
  blueBorder: dynamicColor('#bfdbfe', '#245182'),
  blueDetail: dynamicColor('#2563eb', '#9cc9ff'),
  green: dynamicColor('#047857', '#69d8a6'),
  greenSoft: dynamicColor('#e9fbf2', '#10261c'),
  greenBorder: dynamicColor('#a7f3d0', '#1f5f43'),
  greenDetail: dynamicColor('#059669', '#7be0b1'),
  red: dynamicColor('#b42318', '#ff9b92'),
  redSoft: dynamicColor('#fff0ef', '#351816'),
  redBorder: dynamicColor('#fecaca', '#7f2a24'),
  redDetail: dynamicColor('#dc2626', '#ffb4ad'),
  purple: dynamicColor('#6d28d9', '#b49aff'),
  purpleSoft: dynamicColor('#f4f0ff', '#241a3d'),
  purpleBorder: dynamicColor('#ddd6fe', '#55437f'),
  purpleDetail: dynamicColor('#7c3aed', '#cbbdff'),
  cyan: dynamicColor('#0e7490', '#67d5ec'),
  cyanSoft: dynamicColor('#ecfeff', '#10272d'),
  cyanBorder: dynamicColor('#a5f3fc', '#1e6673'),
  cyanDetail: dynamicColor('#0891b2', '#87e8f6'),
  translucentSurface: dynamicColor('rgba(251, 252, 254, 0.7)', 'rgba(23, 29, 39, 0.82)'),
  translucentGreen: dynamicColor('rgba(233, 251, 242, 0.78)', 'rgba(16, 38, 28, 0.86)'),
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
  compact,
  style,
}: {
  children: ReactNode;
  tone?: 'default' | 'dark' | 'warning' | 'danger';
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[panelBaseStyle, compact && compactPanelStyle, panelToneStyles[tone], style]}>
      {children}
    </View>
  );
}

export function SignalTile({
  label,
  value,
  detail,
  tone = 'neutral',
  onPress,
  selected,
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'cyan';
  onPress?: () => void;
  selected?: boolean;
}) {
  const colors = signalToneStyles[tone];
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper
      disabled={!onPress}
      activeOpacity={0.76}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress?.();
      }}
      style={[
        signalTileStyle,
        { backgroundColor: colors.background, borderColor: colors.border },
        onPress && pressableTileStyle,
        selected && selectedTileStyle,
      ]}
    >
      <Text numberOfLines={1} style={[signalLabelStyle, { color: colors.text }]}>
        {label}
      </Text>
      <Text numberOfLines={1} style={[signalValueStyle, { color: colors.text }]}>
        {value}
      </Text>
      {detail && (
        <Text numberOfLines={1} style={[signalDetailStyle, { color: colors.detail }]}>
          {detail}
        </Text>
      )}
    </Wrapper>
  );
}

export function SignalGrid({ children }: { children: ReactNode }) {
  return <View style={signalGridStyle}>{children}</View>;
}

export function BlockedNotice({ body }: { body: string }) {
  return (
    <View style={blockedNoticeStyle}>
      <Text style={blockedNoticeMarkStyle}>!</Text>
      <Text style={blockedNoticeTextStyle}>{body}</Text>
    </View>
  );
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
      activeOpacity={0.78}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={[buttonBaseStyle, buttonStyles[variant], disabled && disabledStyle, style]}
    >
      <Text style={[buttonTextStyles[variant], textStyle]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function AttentionPanel({
  label,
  title,
  detail,
  tone = 'blue',
  right,
  children,
}: {
  label: string;
  title: string;
  detail?: string;
  tone?: 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'cyan';
  right?: ReactNode;
  children?: ReactNode;
}) {
  const colors = signalToneStyles[tone];
  return (
    <View
      style={[
        attentionPanelStyle,
        { backgroundColor: colors.background, borderColor: colors.border },
      ]}
    >
      <View style={attentionHeaderStyle}>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={[eyebrowStyle, { color: colors.detail }]}>{label}</Text>
          <Text style={[attentionTitleStyle, { color: colors.text }]}>{title}</Text>
          {detail && <Text style={[bodyStyle, { color: colors.detail }]}>{detail}</Text>}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

export function StatusPill({
  label,
  color,
  background,
}: {
  label: string;
  color: CompanionColor;
  background: CompanionColor;
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
export const monoStyle = {
  color: companionColors.ink,
  fontFamily: 'Menlo',
  fontSize: 13,
  backgroundColor: companionColors.surfaceMuted,
  borderColor: companionColors.borderSubtle,
  borderWidth: 1,
  padding: 10,
  borderRadius: 8,
};

const headerStyle = {
  flexDirection: 'row' as const,
  justifyContent: 'space-between' as const,
  gap: 12,
  alignItems: 'flex-start' as const,
};
const screenTitleStyle = {
  color: companionColors.ink,
  fontSize: 32,
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
  borderRadius: 8,
  padding: 16,
  gap: 12,
  shadowColor: '#0f172a',
  shadowOpacity: 0.05,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 10 },
  elevation: 2,
};
const compactPanelStyle = { padding: 12, gap: 8 };
const panelToneStyles = {
  default: {
    backgroundColor: companionColors.surface,
    borderColor: companionColors.borderSubtle,
  },
  dark: {
    backgroundColor: companionColors.dark,
    borderColor: '#273346',
  },
  warning: {
    backgroundColor: companionColors.accentSoft,
    borderColor: dynamicColor('#fedf89', '#9a6a12'),
  },
  danger: {
    backgroundColor: companionColors.redSoft,
    borderColor: dynamicColor('#fecdca', '#7f2a24'),
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
  borderRadius: 8,
  padding: 14,
  gap: 4,
  backgroundColor: companionColors.surfaceMuted,
};
const buttonBaseStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  borderRadius: 8,
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
    borderColor: companionColors.redBorder,
  },
  success: {
    backgroundColor: companionColors.green,
    borderColor: companionColors.green,
  },
};
const buttonTextStyles = {
  primary: { color: companionColors.onDark, fontSize: 15, fontWeight: '900' as const },
  secondary: { color: companionColors.ink, fontSize: 15, fontWeight: '800' as const },
  danger: { color: companionColors.red, fontSize: 15, fontWeight: '900' as const },
  success: { color: companionColors.onDark, fontSize: 15, fontWeight: '900' as const },
};
const disabledStyle = { opacity: 0.46 };
const statusPillStyle = {
  alignSelf: 'flex-start' as const,
  borderRadius: 999,
  paddingHorizontal: 10,
  paddingVertical: 7,
};
const signalToneStyles = {
  neutral: {
    background: companionColors.surface,
    border: companionColors.borderSubtle,
    text: companionColors.ink,
    detail: companionColors.subtle,
  },
  blue: {
    background: companionColors.blueSoft,
    border: companionColors.blueBorder,
    text: companionColors.blue,
    detail: companionColors.blueDetail,
  },
  green: {
    background: companionColors.greenSoft,
    border: companionColors.greenBorder,
    text: companionColors.green,
    detail: companionColors.greenDetail,
  },
  amber: {
    background: companionColors.accentSoft,
    border: dynamicColor('#fed7aa', '#9a6a12'),
    text: companionColors.accentInk,
    detail: dynamicColor('#b45309', '#fbbf24'),
  },
  red: {
    background: companionColors.redSoft,
    border: companionColors.redBorder,
    text: companionColors.red,
    detail: companionColors.redDetail,
  },
  purple: {
    background: companionColors.purpleSoft,
    border: companionColors.purpleBorder,
    text: companionColors.purple,
    detail: companionColors.purpleDetail,
  },
  cyan: {
    background: companionColors.cyanSoft,
    border: companionColors.cyanBorder,
    text: companionColors.cyan,
    detail: companionColors.cyanDetail,
  },
};
const signalTileStyle = {
  flexGrow: 1,
  flexBasis: '30%' as const,
  minWidth: 100,
  borderWidth: 1,
  borderRadius: 8,
  paddingHorizontal: 12,
  paddingVertical: 11,
  gap: 3,
  shadowColor: '#0f172a',
  shadowOpacity: 0.035,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 6 },
  elevation: 1,
};
const pressableTileStyle = {
  transform: [{ translateY: 0 }],
};
const selectedTileStyle = {
  borderWidth: 2,
};
const signalGridStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 8,
};
const signalLabelStyle = {
  fontSize: 11,
  fontWeight: '900' as const,
};
const signalValueStyle = {
  fontSize: 22,
  fontWeight: '900' as const,
};
const signalDetailStyle = {
  fontSize: 12,
  fontWeight: '700' as const,
};
const blockedNoticeStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 9,
  borderWidth: 1,
  borderColor: companionColors.redBorder,
  borderRadius: 8,
  backgroundColor: companionColors.redSoft,
  padding: 10,
};
const blockedNoticeMarkStyle = {
  width: 20,
  height: 20,
  borderRadius: 999,
  backgroundColor: companionColors.red,
  color: companionColors.onDark,
  textAlign: 'center' as const,
  fontSize: 13,
  fontWeight: '900' as const,
};
const blockedNoticeTextStyle = {
  flex: 1,
  color: companionColors.red,
  fontSize: 13,
  lineHeight: 19,
  fontWeight: '800' as const,
};
const attentionPanelStyle = {
  borderWidth: 1,
  borderRadius: 12,
  padding: 16,
  gap: 14,
  shadowColor: '#0f172a',
  shadowOpacity: 0.06,
  shadowRadius: 20,
  shadowOffset: { width: 0, height: 12 },
  elevation: 2,
};
const attentionHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 12,
};
const attentionTitleStyle = {
  fontSize: 20,
  lineHeight: 25,
  fontWeight: '900' as const,
};
