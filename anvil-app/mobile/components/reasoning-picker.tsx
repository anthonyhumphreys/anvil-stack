import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useState, type ComponentProps } from 'react';
import { Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReasoningEffort } from '../../src/shared/types';
import { companionColors } from '@/components/companion-ui';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const REASONING_OPTIONS: {
  value: ReasoningEffort;
  label: string;
  detail: string;
  icon: IconName;
}[] = [
  { value: 'minimal', label: 'Minimal', detail: 'Fastest', icon: 'flash-on' },
  { value: 'low', label: 'Low', detail: 'Light', icon: 'speed' },
  { value: 'medium', label: 'Medium', detail: 'Default', icon: 'tune' },
  { value: 'high', label: 'High', detail: 'Deeper', icon: 'psychology' },
  { value: 'xhigh', label: 'XHigh', detail: 'Extra', icon: 'all-inclusive' },
  { value: 'max', label: 'Max', detail: 'Deep', icon: 'bolt' },
  { value: 'ultra', label: 'Ultra', detail: 'Agents', icon: 'hub' },
];

export function ReasoningPicker({
  value,
  onChange,
  variant = 'light',
  style,
}: {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  variant?: 'light' | 'dark';
  style?: StyleProp<ViewStyle>;
}) {
  const [open, setOpen] = useState(false);
  const selected =
    REASONING_OPTIONS.find((option) => option.value === value) ?? REASONING_OPTIONS[2];
  const dark = variant === 'dark';

  return (
    <View style={[pickerWrapStyle, style]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Reasoning, ${selected.label}`}
        accessibilityState={{ expanded: open }}
        activeOpacity={0.78}
        onPress={() => setOpen((current) => !current)}
        style={[
          pickerButtonStyle,
          {
            backgroundColor: dark ? companionColors.darkRaised : companionColors.surface,
            borderColor: dark ? companionColors.darkBorder : companionColors.borderSubtle,
          },
        ]}
      >
        <MaterialIcons
          name={selected.icon}
          size={15}
          color={dark ? companionColors.darkMuted : companionColors.subtle}
        />
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={[
              pickerEyebrowStyle,
              { color: dark ? companionColors.darkMuted : companionColors.subtle },
            ]}
          >
            Reasoning
          </Text>
          <Text
            numberOfLines={1}
            style={[
              pickerValueStyle,
              { color: dark ? companionColors.onDark : companionColors.ink },
            ]}
          >
            {selected.label}
          </Text>
        </View>
        <MaterialIcons
          name={open ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
          size={18}
          color={dark ? companionColors.darkMuted : companionColors.subtle}
        />
      </TouchableOpacity>

      {open && (
        <View
          style={[
            menuStyle,
            {
              backgroundColor: dark ? companionColors.darkRaised : companionColors.surface,
              borderColor: dark ? companionColors.darkBorder : companionColors.borderSubtle,
            },
          ]}
        >
          {REASONING_OPTIONS.map((option) => {
            const active = option.value === value;
            return (
              <TouchableOpacity
                accessibilityRole="menuitem"
                accessibilityState={{ selected: active }}
                key={option.value}
                activeOpacity={0.78}
                onPress={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={[
                  menuItemStyle,
                  active && {
                    backgroundColor: dark
                      ? companionColors.darkControlActive
                      : companionColors.blueSoft,
                  },
                ]}
              >
                <MaterialIcons
                  name={option.icon}
                  size={16}
                  color={
                    active
                      ? dark
                        ? companionColors.accent
                        : companionColors.blue
                      : dark
                        ? companionColors.darkMuted
                        : companionColors.subtle
                  }
                />
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      menuItemTitleStyle,
                      { color: dark ? companionColors.onDark : companionColors.ink },
                    ]}
                  >
                    {option.label}
                  </Text>
                  <Text
                    style={[
                      menuItemDetailStyle,
                      { color: dark ? companionColors.darkMuted : companionColors.subtle },
                    ]}
                  >
                    {option.detail}
                  </Text>
                </View>
                {active && (
                  <MaterialIcons
                    name="check"
                    size={16}
                    color={dark ? companionColors.accent : companionColors.blue}
                  />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

const pickerWrapStyle = {
  position: 'relative' as const,
  zIndex: 20,
  minWidth: 150,
  flexGrow: 1,
};
const pickerButtonStyle = {
  minHeight: 44,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
  borderWidth: 1,
  borderRadius: 8,
  paddingHorizontal: 10,
  paddingVertical: 7,
};
const pickerEyebrowStyle = {
  fontSize: 10,
  fontWeight: '900' as const,
};
const pickerValueStyle = {
  fontSize: 13,
  fontWeight: '900' as const,
};
const menuStyle = {
  position: 'absolute' as const,
  top: 48,
  left: 0,
  right: 0,
  borderWidth: 1,
  borderRadius: 8,
  padding: 4,
  gap: 2,
  shadowColor: '#0f172a',
  shadowOpacity: 0.18,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 10 },
  elevation: 10,
  zIndex: 30,
};
const menuItemStyle = {
  minHeight: 46,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 9,
  borderRadius: 6,
  paddingHorizontal: 9,
  paddingVertical: 7,
};
const menuItemTitleStyle = {
  fontSize: 13,
  fontWeight: '900' as const,
};
const menuItemDetailStyle = {
  fontSize: 11,
  fontWeight: '800' as const,
};
