'use strict';
// Without an Apple Developer ID the app isn't notarized, and on Apple Silicon a half-signed bundle shows
// up as "damaged", so every build is signed here:
//   TITLI_SIGN_IDENTITY set (CI, from the release keys): with Titli's own self-signed certificate. The
//     signature is then the same on every version, so the Keychain keeps trusting the update and Titli's
//     saved data can be encrypted with a Keychain key without a password prompt after each update.
//   otherwise: ad-hoc. People only see the usual "Open Anyway" prompt the first time either way.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (/-temp$/.test(path.basename(context.appOutDir))) return; // halves of a universal build, merged later
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;     // a real certificate will sign it instead
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = process.env.TITLI_SIGN_IDENTITY;
  execFileSync('codesign', ['--force', '--deep', '--sign', id || '-', app], { stdio: 'inherit' });
  if (id) execFileSync('codesign', ['-dv', '--verbose=2', app], { stdio: 'inherit' });
};
