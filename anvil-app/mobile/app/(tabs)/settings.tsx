import { MaterialIcons } from '@react-native-vector-icons/material-icons';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import type { DevicePresenceEntry } from '../../../cloud/contract/companion';
import {
  enrollWithCode,
  getAccountConnection,
  getAccountPresence,
  signOutAccount,
  type AccountConnection,
} from '@/lib/anvil-account';
import { dialAccountHosts } from '@/lib/account-dial';
import { removeAccountConnections } from '@/lib/anvil-api';
import {
  ActionButton,
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
  const [account, setAccount] = useState<AccountConnection | null>(null);
  const [accountDevices, setAccountDevices] = useState<DevicePresenceEntry[]>([]);
  const [accountApiUrl, setAccountApiUrl] = useState('');
  const [accountCode, setAccountCode] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);

  const refreshAccount = async () => {
    const connection = await getAccountConnection();
    setAccount(connection);
    if (!connection) {
      setAccountDevices([]);
      return;
    }
    try {
      const presence = await getAccountPresence();
      setAccountDevices(presence.devices);
      await dialAccountHosts();
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : 'Failed to load account devices');
    }
  };

  useEffect(() => {
    void refreshAccount();
  }, []);

  const connectAccount = async () => {
    setAccountBusy(true);
    setAccountError(null);
    try {
      await enrollWithCode(accountApiUrl, accountCode, deviceName);
      setAccountCode('');
      await refreshAccount();
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : 'Failed to connect account');
    } finally {
      setAccountBusy(false);
    }
  };

  const confirmSignOutAccount = () => {
    Alert.alert('Sign out of account?', 'This device loses access to account-connected hosts.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            await signOutAccount();
            await removeAccountConnections();
            await refreshAccount();
            await refresh();
          })();
        },
      },
    ]);
  };

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
      <ScreenHeader
        eyebrow={connection ? 'Connected' : 'Not paired'}
        title="Connection"
        right={
          <ActionButton
            label="Refresh"
            variant="secondary"
            onPress={() => void refresh()}
            style={{ paddingVertical: 8 }}
          />
        }
      />

      <SignalGrid>
        <SignalTile
          label="Host"
          value={connection ? 'Live' : 'None'}
          detail={connection ? hostLabel(connection.baseUrl) : 'pair required'}
          tone={connection ? 'green' : 'amber'}
        />
        <SignalTile
          label="Paired"
          value={connections.length}
          detail={connections.length === 1 ? 'Mac' : 'Macs'}
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
          <EmptyState title="No host" body="Scan a pairing code or enter a token." />
        )}
      </Panel>

      <Panel>
        <View style={panelHeaderStyle}>
          <View style={iconBoxStyle}>
            <MaterialIcons
              name={account ? 'cloud-done' : 'cloud-off'}
              size={18}
              color={account ? companionColors.green : companionColors.subtle}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={titleStyle}>Anvil account</Text>
            <Text style={bodyStyle}>
              {account
                ? `Signed in as ${account.session.accountId}`
                : 'Sign in to reach every enrolled host — no LAN pairing needed.'}
            </Text>
          </View>
        </View>
        {account ? (
          <>
            {accountDevices.length > 0 ? (
              accountDevices.map((device) => (
                <View key={device.enrollmentId} style={accountDeviceRowStyle}>
                  <MaterialIcons
                    name="circle"
                    size={10}
                    color={device.online ? companionColors.green : companionColors.faint}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text numberOfLines={1} style={titleStyle}>
                      {device.self ? 'This device' : device.enrollmentId}
                    </Text>
                    <Text numberOfLines={1} style={subtleStyle}>
                      {device.online
                        ? `online · ${(device.endpoints ?? [])
                            .map((endpoint) => endpoint.kind)
                            .join(', ') || 'cloud only'}`
                        : `last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
                    </Text>
                  </View>
                </View>
              ))
            ) : (
              <EmptyState title="No devices" body="No other enrollments are online." />
            )}
            <ActionButton
              label={accountBusy ? 'Working…' : 'Refresh devices'}
              variant="secondary"
              disabled={accountBusy}
              onPress={() => void refreshAccount()}
            />
            <ActionButton
              label="Sign out of account"
              variant="danger"
              onPress={confirmSignOutAccount}
            />
          </>
        ) : (
          <>
            <TextInput
              value={accountApiUrl}
              onChangeText={setAccountApiUrl}
              placeholder="https://your-anvil-backend"
              placeholderTextColor={companionColors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={inputStyle}
            />
            <TextInput
              value={accountCode}
              onChangeText={setAccountCode}
              placeholder="Enrollment code"
              placeholderTextColor={companionColors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
            <Text style={subtleStyle}>
              Mint a code from the account website (Connect a device) or desktop Sync &amp; Mesh
              settings.
            </Text>
            <ActionButton
              label={accountBusy ? 'Connecting…' : 'Connect account'}
              disabled={accountBusy || !accountApiUrl.trim() || !accountCode.trim()}
              onPress={() => void connectAccount()}
            />
          </>
        )}
        {accountError ? (
          <Text selectable style={{ color: companionColors.red, fontWeight: '800' }}>
            {accountError}
          </Text>
        ) : null}
      </Panel>

      <Panel>
        <View style={panelHeaderStyle}>
          <View style={iconBoxStyle}>
            <MaterialIcons name="qr-code-scanner" size={18} color={companionColors.accentInk} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={titleStyle}>{connection ? 'Pair another Mac' : 'Pair by QR'}</Text>
            <Text style={bodyStyle}>Desktop Settings, Mobile Companion, QR.</Text>
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
          <PairingStep index="1" label="Open Settings on the Mac" />
          <PairingStep index="2" label="Show Mobile Companion QR" />
          <PairingStep index="3" label="Scan it here" />
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
            label={pairing ? 'Pairing…' : 'Scan QR Code'}
            disabled={pairing}
            onPress={startScan}
          />
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
                      {host.requiresHostApproval
                        ? 'waiting for approval on host'
                        : host.baseUrl}
                    </Text>
                  </View>
                  {host.authMode === 'account' ? (
                    <MaterialIcons
                      name="cloud-done"
                      size={16}
                      color={companionColors.accentInk}
                    />
                  ) : null}
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
          label="Save Manual Connection"
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
const accountDeviceRowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 10,
  borderWidth: 1,
  borderColor: companionColors.borderSubtle,
  borderRadius: 8,
  backgroundColor: companionColors.surfaceMuted,
  padding: 10,
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
