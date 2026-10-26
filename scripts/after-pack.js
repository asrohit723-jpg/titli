'use strict';
// Without an Apple Developer ID the app ships unsigned, and on Apple Silicon a half-signed bundle shows
// up as "damaged". An ad-hoc signature keeps it whole, so people only see the usual
// "Open Anyway" prompt the first time.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (/-temp$/.test(path.basename(context.appOutDir))) return; // halves of a universal build, merged later
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;     // a real certificate will sign it instead
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
