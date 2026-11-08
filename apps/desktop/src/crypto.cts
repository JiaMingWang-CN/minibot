const { safeStorage } = require('electron') as typeof import('electron');

function electronCrypto(): import('@minibot/core').KeyCrypto {
  return {
    backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'),
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (buf: Buffer) => safeStorage.decryptString(buf),
  };
}

module.exports = { electronCrypto };
