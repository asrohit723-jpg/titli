'use strict';
// Builds the small presence helper for this computer: native/mac on a Mac (Swift), native/win on
// Windows (C#, compiled with the .NET Framework compiler every Windows 10/11 PC already has).
// Titli still runs without it; it just can't tell when you're on a call.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const native = path.join(__dirname, '../native');

if (process.platform === 'darwin') {
  execFileSync('bash', [path.join(native, 'mac/build.sh')], { stdio: 'inherit' });
} else if (process.platform === 'win32') {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const csc = ['Framework64', 'Framework'].map(f => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(f => fs.existsSync(f));
  if (!csc) { console.log('Skipping titli-presence.exe: the .NET Framework compiler (csc.exe) was not found.'); process.exit(0); }
  const bin = path.join(native, 'win/bin');
  fs.mkdirSync(bin, { recursive: true });
  const out = path.join(bin, 'titli-presence.exe');
  execFileSync(csc, ['/nologo', '/target:exe', '/optimize+', '/platform:anycpu', `/out:${out}`, path.join(native, 'win/TitliPresence.cs')], { stdio: 'inherit' });
  console.log('Built native/win/bin/titli-presence.exe');
} else {
  console.log('Skipping the presence helper: it is built on a Mac or a Windows PC.');
}
