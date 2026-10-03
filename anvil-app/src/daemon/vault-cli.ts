import { fstatSync, readSync } from 'node:fs';

export type VaultCommand =
  | { kind: 'status' | 'migrate' }
  | { kind: 'setup'; mode: 'passphrase' }
  | { kind: 'setup'; mode: 'key-file'; keyFilePath: string }
  | { kind: 'use'; provider: 'keychain' | 'vault' };

export function parseVaultCommand(args: readonly string[]): VaultCommand {
  const [action, ...rest] = args;
  if ((action === 'status' || action === 'migrate') && rest.length === 0) return { kind: action };
  if (action === 'setup' && rest.length === 1 && rest[0] === '--passphrase-stdin')
    return { kind: 'setup', mode: 'passphrase' };
  if (action === 'setup' && rest.length === 2 && rest[0] === '--key-file' && rest[1].length > 0)
    return { kind: 'setup', mode: 'key-file', keyFilePath: rest[1] };
  if (action === 'use' && rest.length === 1 && (rest[0] === 'keychain' || rest[0] === 'vault'))
    return { kind: 'use', provider: rest[0] };
  throw new Error(
    'Use vault status, vault setup --passphrase-stdin, vault setup --key-file <path>, vault use keychain|vault, or vault migrate. Passphrases must never be command arguments.',
  );
}

export function readVaultPassphraseFromStdin(): string {
  if (process.stdin.isTTY)
    throw new Error(
      'Pipe the vault passphrase through stdin; interactive terminal input would be echoed.',
    );
  if (fstatSync(0).isFile() && fstatSync(0).size > 4096)
    throw new Error('Vault passphrase input is too large.');
  const input = Buffer.alloc(4097);
  let length = 0;
  try {
    while (length < input.length) {
      const count = readSync(0, input, length, input.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 4096) throw new Error('Vault passphrase input is too large.');
    const passphrase = input
      .subarray(0, length)
      .toString('utf8')
      .replace(/\r?\n$/, '');
    if (passphrase.length === 0) throw new Error('No vault passphrase was supplied.');
    return passphrase;
  } finally {
    input.fill(0);
  }
}
