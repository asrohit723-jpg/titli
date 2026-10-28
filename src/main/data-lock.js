'use strict';
// How saved data (your keys, people and notes) is kept on disk.
//   Windows: encrypted with a key Windows keeps for your account (DPAPI). It never asks for anything.
//   Mac: a file only your account can open. Titli never uses the Keychain, so it never asks for your Mac password.
//     (Without a paid Apple developer ID, macOS ties Keychain access to each exact build and would ask again after
//     every update.) A file that 0.1.45 to 0.1.52 encrypted with the Keychain can't be read without asking, so it is
//     set aside and Titli starts fresh.
// safeStorage is only looked at on Windows.
function dataLock({ platform, packaged, smoke, safeStorage }) {
  if (platform !== 'win32' || !packaged || smoke) return { crypt: null, encrypt: false };
  const crypt = { name: 'safeStorage', encrypt: s => safeStorage.encryptString(s), decrypt: b => safeStorage.decryptString(b) };
  let encrypt = false;
  try { encrypt = safeStorage.isEncryptionAvailable(); } catch (e) { encrypt = false; }
  return { crypt, encrypt };
}

module.exports = { dataLock };
