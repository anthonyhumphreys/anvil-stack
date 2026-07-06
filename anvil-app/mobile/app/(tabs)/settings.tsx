import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { ComponentProps } from 'react';
import { useRef, useState } from 'react';
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import {
  ActionButton,
  AttentionPanel,
  EmptyState,
  Panel,
  ScreenHeader,
  SignalGrid,
  SignalTile,
  bodyStyle,
  companionColors,
  inputStyle,
  screenStyle,
  scrollContentStyle,
  subtleStyle,
  titleStyle,
} from '@/components/companion-ui';
import { useCompanion } from '@/contexts/companion-context';

export default function SettingsScreen() {
  const {
    connection,
    connections,
    error,
    pairFromQr,
    setManualConnection,
    selectHost,
    forgetHost,
    disconnect,
    refresh,
  } = useCompanion();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState(false);
  const pairingInFlightRef = useRef(false);
  const [deviceName, setDeviceName] = useState('Anvil Mobile');
  const [manualBaseUrl, setManualBaseUrl] = useState('');
  const [manualToken, setManualToken] = useState('');

  const handleBarcode = async (result: BarcodeScanningResult) => {
    if (!scanning || pairingInFlightRef.current) return;

    pairingInFlightRef.current = true;
    setPairing(true);
    setScanning(false);

    try {
      await pairFromQr(result.data, deviceName);
      await refresh();
    } catch {
      // pairFromQr stores the user-facing error in companion context.
    } finally {
      pairingInFlightRef.current = false;
      setPairing(false);
    }
  };

  const startScan = async () => {
    if (!permission?.granted) {
      const nextPermission = await requestPermission();
      if (!nextPermission.granted) return;
    }
    setScanning(true);
  };

  const saveManual = async () => {
    if (!manualBaseUrl.trim() || !manualToken.trim()) return;
    await setManualConnection({
      baseUrl: manualBaseUrl.trim().replace(/\/+$/, ''),
      token: manualToken.trim(),
      deviceName,
    });
    await refresh();
  };

  const confirmForgetHost = (connectionId: string, label: string) => {
    Alert.alert('Forget host?', `Remove ${label} from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: () => void forgetHost(connectionId),
      },
    ]);
  };

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={scrollContentStyle}
    >
      <ScreenHeader eyebrow={connection ? 'Connected' : 'Not paired'} title="Hosts" />

      <AttentionPanel
        label="COMPANION SURFACES"
        title={connection ? 'Phone, widgets, and watch are using this host' : 'Pair a Mac first'}
        detail={
          connection
            ? 'Widgets and Live Activity update from the same host snapshot as this app.'
            : 'No native surfaces update until the phone has a trusted desktop token.'
        }
        tone={connection ? 'green' : 'amber'}
        right={
          connection ? (
            <ActionButton
              label="Refresh"
              variant="secondary"
              onPress={() => void refresh()}
              style={{ paddingVertical: 8 }}
            />
          ) : undefined
        }
      >
        <View style={surfaceGridStyle}>
          <SurfaceChip icon="phone-iphone" label="App" active={Boolean(connection)} />
          <SurfaceChip icon="widgets" label="Widget" active={Boolean(connection)} />
          <SurfaceChip icon="bolt" label="Live Activity" active={Boolean(connection)} />
          <SurfaceChip icon="watch" label="Watch" active={Boolean(connection)} />
        </View>
      </AttentionPanel>

      <SignalGrid>
        <SignalTile
          label="Active"
          value={connection ? 'Yes' : 'No'}
          detail={connection ? hostLabel(connection.baseUrl) : 'not paired'}
          tone={connection ? 'green' : 'amber'}
        />
        <SignalTile
          label="Hosts"
          value={connections.length}
          detail={connections.length === 1 ? 'paired Mac' : 'paired Macs'}
          tone={connections.length > 0 ? 'blue' : 'neutral'}
        />
        <SignalTile
          label="Camera"
          value={permission?.granted ? 'Ready' : 'Ask'}
          detail="QR pairing"
          tone={permission?.granted ? 'green' : 'neutral'}
        />
      </SignalGrid>

      <Panel>
        <View style={panelHeaderStyle}>
          <View style={iconBoxStyle}>
            <MaterialIcons name="qr-code-scanner" size={18} color={companionColors.accentInk} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={titleStyle}>Pair by QR</Text>
            <Text style={bodyStyle}>Desktop Settings, Mobile Companion.</Text>
          </View>
        </View>
        <TextInput
          value={deviceName}
          onChangeText={setDeviceName}
          placeholder="Device name"
          placeholderTextColor={companionColors.faint}
          style={inputStyle}
        />
        <View style={pairingStepsStyle}>
          <PairingStep index="1" label="Open desktop Settings" />
          <PairingStep index="2" label="Show Mobile Companion QR" />
          <PairingStep index="3" label="Scan here" />
        </View>
        {scanning ? (
          <View style={scannerFrameStyle}>
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarcode}
            />
          </View>
        ) : (
          <ActionButton
            label={pairing ? 'Pairing...' : 'Scan QR code'}
            disabled={pairing}
            onPress={startScan}
          />
        )}
      </Panel>

      <Panel>
        <View style={panelHeaderStyle}>
          <View style={iconBoxStyle}>
            <MaterialIcons
              name={connection ? 'link' : 'link-off'}
              size={18}
              color={connection ? companionColors.green : companionColors.subtle}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={titleStyle}>Active host</Text>
            <Text selectable style={bodyStyle}>
              {connection ? connection.baseUrl : 'No desktop paired'}
            </Text>
          </View>
        </View>
        {connection ? (
          <ActionButton
            label="Forget active host"
            variant="danger"
            onPress={() => void disconnect()}
          />
        ) : (
          <EmptyState title="Waiting for a Mac" body="Scan a QR code or enter a token." />
        )}
      </Panel>

      <Panel>
        <View style={panelHeaderStyle}>
          <View style={iconBoxStyle}>
            <MaterialIcons name="computer" size={18} color={companionColors.accentInk} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={titleStyle}>Paired hosts</Text>
            <Text style={bodyStyle}>Select the Mac to control.</Text>
          </View>
        </View>
        {connections.length > 0 ? (
          connections.map((host) => {
            const active = host.id === connection?.id;
            return (
              <View key={host.id} style={[hostRowStyle, active && activeHostRowStyle]}>
                <TouchableOpacity
                  disabled={active}
                  onPress={() => void selectHost(host.id)}
                  style={hostMainStyle}
                >
                  <View
                    style={[
                      hostIconStyle,
                      {
                        backgroundColor: active
                          ? companionColors.greenSoft
                          : companionColors.surfaceMuted,
                      },
                    ]}
                  >
                    <MaterialIcons
                      name={active ? 'radio-button-checked' : 'radio-button-unchecked'}
                      size={18}
                      color={active ? companionColors.green : companionColors.subtle}
                    />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text numberOfLines={1} style={titleStyle}>
                      {host.deviceName || hostLabel(host.baseUrl)}
                    </Text>
                    <Text selectable numberOfLines={1} style={subtleStyle}>
                      {host.baseUrl}
                    </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    confirmForgetHost(host.id, host.deviceName || hostLabel(host.baseUrl))
                  }
                  style={forgetButtonStyle}
                >
                  <MaterialIcons name="delete-outline" size={20} color={companionColors.red} />
                </TouchableOpacity>
              </View>
            );
          })
        ) : (
          <EmptyState title="No hosts paired" body="Scan a pairing code." />
        )}
      </Panel>

      <Panel>
        <Text style={titleStyle}>Manual connection</Text>
        <Text style={bodyStyle}>Base URL and token.</Text>
        <TextInput
          value={manualBaseUrl}
          onChangeText={setManualBaseUrl}
          placeholder="http://100.x.y.z:47631"
          placeholderTextColor={companionColors.faint}
          autoCapitalize="none"
          style={inputStyle}
        />
        <TextInput
          value={manualToken}
          onChangeText={setManualToken}
          placeholder="Device token"
          placeholderTextColor={companionColors.faint}
          autoCapitalize="none"
          secureTextEntry
          style={inputStyle}
        />
        <ActionButton
          label="Save manual connection"
          variant="secondary"
          onPress={saveManual}
          disabled={!manualBaseUrl.trim() || !manualToken.trim()}
        />
      </Panel>

      {error && (
        <Panel tone="danger">
          <Text selectable style={{ color: companionColors.red, fontWeight: '800' }}>
            {error}
          </Text>
        </Panel>
      )}

      <TouchableOpacity onPress={() => void refresh()} style={refreshLinkStyle}>
        <MaterialIcons name="sync" size={16} color={companionColors.subtle} />
        <Text style={subtleStyle}>Refresh companion state</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const panelHeaderStyle = {
  flexDirection: 'row' as const,
  alignItems: 'flex-start' as const,
  gap: 12,
};
const iconBoxStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 10,
  backgroundColor: companionColors.accentSoft,
};
const scannerFrameStyle = {
  height: 320,
  overflow: 'hidden' as const,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: companionColors.border,
};
const pairingStepsStyle = {
  gap: 8,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  borderRadius: 8,
  backgroundColor: companionColors.surfaceMuted,
  padding: 10,
};
const pairingStepStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 9,
};
const pairingStepIndexStyle = {
  width: 22,
  height: 22,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  borderRadius: 999,
  backgroundColor: companionColors.dark,
};
const pairingStepIndexTextStyle = {
  color: companionColors.onDark,
  fontSize: 12,
  fontWeight: '900' as const,
};
const pairingStepLabelStyle = {
  color: companionColors.muted,
  fontSize: 13,
  fontWeight: '700' as const,
  flex: 1,
};
const refreshLinkStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: 8,
  paddingVertical: 8,
};
const hostRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 8,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  backgroundColor: companionColors.surface,
  padding: 10,
};
const activeHostRowStyle = {
  borderColor: companionColors.greenBorder,
  backgroundColor: companionColors.greenSoft,
};
const hostMainStyle = {
  flex: 1,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 10,
};
const hostIconStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 34,
  height: 34,
  borderRadius: 9,
};
const forgetButtonStyle = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  width: 38,
  height: 38,
  borderRadius: 8,
  backgroundColor: companionColors.redSoft,
};

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'Anvil host';
  }
}

function PairingStep({ index, label }: { index: string; label: string }) {
  return (
    <View style={pairingStepStyle}>
      <View style={pairingStepIndexStyle}>
        <Text style={pairingStepIndexTextStyle}>{index}</Text>
      </View>
      <Text style={pairingStepLabelStyle}>{label}</Text>
    </View>
  );
}

function SurfaceChip({
  icon,
  label,
  active,
}: {
  icon: ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  active: boolean;
}) {
  return (
    <View style={[surfaceChipStyle, active && activeSurfaceChipStyle]}>
      <MaterialIcons
        name={icon}
        size={16}
        color={active ? companionColors.green : companionColors.subtle}
      />
      <Text style={[surfaceChipTextStyle, active && activeSurfaceChipTextStyle]}>{label}</Text>
    </View>
  );
}

const surfaceGridStyle = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  gap: 8,
};
const surfaceChipStyle = {
  flexGrow: 1,
  flexBasis: '45%' as const,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: 7,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  borderRadius: 999,
  backgroundColor: companionColors.translucentSurface,
  paddingHorizontal: 10,
  paddingVertical: 9,
};
const activeSurfaceChipStyle = {
  borderColor: companionColors.greenBorder,
  backgroundColor: companionColors.translucentGreen,
};
const surfaceChipTextStyle = {
  color: companionColors.subtle,
  fontSize: 12,
  fontWeight: '900' as const,
};
const activeSurfaceChipTextStyle = {
  color: companionColors.green,
};
