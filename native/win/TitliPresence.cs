// titli-presence.exe: tells Titli, every two seconds, whether this is a bad moment for a butterfly (Windows).
// It only *reads* whether another app is using the camera or microphone right now (Windows keeps this in
// the registry for its privacy indicators) and whether a full-screen app or presentation is in front.
// It never turns anything on, records, or looks at the screen.
// Output: one JSON line per tick, e.g. {"camera":false,"mic":false,"fullscreen":false,"sharing":false}
// Usage: titli-presence.exe <parent pid>   (stops when that process does)
//        titli-presence.exe --once         (prints one line and exits)
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

static class TitliPresence
{
    [DllImport("shell32.dll")]
    static extern int SHQueryUserNotificationState(out int state);

    const string Store = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\";

    // "webcam" or "microphone": true when some app has started using it and not stopped yet
    static bool InUse(string capability)
    {
        try
        {
            using (RegistryKey root = Registry.CurrentUser.OpenSubKey(Store + capability))
                return root != null && Scan(root, 0);
        }
        catch { return false; }
    }

    static bool Scan(RegistryKey key, int depth)
    {
        object start = key.GetValue("LastUsedTimeStart"), stop = key.GetValue("LastUsedTimeStop");
        if (start is long && stop is long && (long)start > 0 && (long)stop == 0) return true;
        if (depth >= 3) return false;
        foreach (string name in key.GetSubKeyNames())
        {
            try
            {
                using (RegistryKey sub = key.OpenSubKey(name))
                    if (sub != null && Scan(sub, depth + 1)) return true;
            }
            catch { }
        }
        return false;
    }

    // what Windows itself uses to keep notifications quiet:
    // 2 = a full-screen app, 3 = full-screen Direct3D (games, some video), 4 = presentation mode
    static bool FullScreen()
    {
        int state;
        try { if (SHQueryUserNotificationState(out state) != 0) return false; }
        catch { return false; }
        return state == 2 || state == 3 || state == 4;
    }

    static bool Alive(int pid)
    {
        try { using (Process p = Process.GetProcessById(pid)) return !p.HasExited; }
        catch { return false; }
    }

    static string B(bool v) { return v ? "true" : "false"; }

    static int Main(string[] args)
    {
        int parent = 0;
        bool once = Array.IndexOf(args, "--once") >= 0;
        if (args.Length > 0 && !once) int.TryParse(args[0], out parent);
        while (true)
        {
            string line = "{\"camera\":" + B(InUse("webcam")) + ",\"mic\":" + B(InUse("microphone")) +
                          ",\"fullscreen\":" + B(FullScreen()) + ",\"sharing\":false}";
            try { Console.Out.WriteLine(line); Console.Out.Flush(); }
            catch (IOException) { return 0; }
            if (once) return 0;
            Thread.Sleep(2000);
            if (parent > 0 && !Alive(parent)) return 0;
        }
    }
}
