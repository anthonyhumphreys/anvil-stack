import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRef, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import {
  ActionButton,
  EmptyState,
  Panel,
  ScreenHeader,
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
  const { connection, error, pairFromQr, setManualConnection, disconnect, refresh } =
    useCompanion();
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

  return (
    <ScrollView
      style={screenStyle}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={scrollContentStyle}
    >
      <ScreenHeader
        eyebrow="Companion setup"
        title="Settings"
        detail="Pair this device with the local Anvil companion server on your Mac."
      />

      <Panel>
        <View style={panelHeaderStyle}>
          <View style={iconBoxStyle}>
            <MaterialIcons name="qr-code-scanner" size={18} color={companionColors.accentInk} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={titleStyle}>Pairing</Text>
            <Text style={bodyStyle}>
              Enable Mobile Companion in Anvil Settings on your Mac, then scan the QR code.
            </Text>
          </View>
        </View>
        <TextInput
          value={deviceName}
          onChangeText={setDeviceName}
          placeholder="Device name"
          placeholderTextColor={companionColors.faint}
          style={inputStyle}
        />
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
            <Text style={titleStyle}>Connection</Text>
            <Text selectable style={bodyStyle}>
              {connection ? connection.baseUrl : 'No desktop paired'}
            </Text>
          </View>
        </View>
        {connection ? (
          <ActionButton label="Disconnect" variant="danger" onPress={() => void disconnect()} />
        ) : (
          <EmptyState
            title="Waiting for a Mac"
            body="Pair by QR code or use a manual token when scanning is not available."
          />
        )}
      </Panel>

      <Panel>
        <Text style={titleStyle}>Manual connection</Text>
        <Text style={bodyStyle}>Useful when QR scanning is being fussy. Technology, majestically.</Text>
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
  borderRadius: 12,
  borderWidth: 1,
  borderColor: companionColors.border,
};
const refreshLinkStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: 8,
  paddingVertical: 8,
};
