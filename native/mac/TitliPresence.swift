// titli-presence: tells Titli, every two seconds, whether this is a bad moment for a butterfly.
// It only *reads* whether the camera or microphone is already in use by another app and whether
// the app in front is full screen. It never turns anything on, records, or looks at the screen.
// Output: one JSON line per tick, e.g. {"camera":false,"mic":false,"fullscreen":false,"sharing":false}

import AppKit
import CoreAudio
import CoreMediaIO
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
_ = NSApplication.shared

func micInUse() -> Bool {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0 else { return false }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return false }
    for id in ids {
        // only devices with input streams (microphones)
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: 0)
        var sSize: UInt32 = 0
        if AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &sSize) != noErr || sSize == 0 { continue }
        var running = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere, mScope: kAudioObjectPropertyScopeGlobal, mElement: 0)
        var on: UInt32 = 0
        var rSize = UInt32(MemoryLayout<UInt32>.size)
        if AudioObjectGetPropertyData(id, &running, 0, nil, &rSize, &on) == noErr && on != 0 { return true }
    }
    return false
}

func cameraInUse() -> Bool {
    var addr = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(0))
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject), &addr, 0, nil, &size) == 0, size > 0 else { return false }
    var ids = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &addr, 0, nil, size, &used, &ids) == 0 else { return false }
    for id in ids {
        var running = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeWildcard),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementWildcard))
        var on: UInt32 = 0
        var got: UInt32 = 0
        if CMIOObjectGetPropertyData(id, &running, 0, nil, UInt32(MemoryLayout<UInt32>.size), &got, &on) == 0 && on != 0 { return true }
    }
    return false
}

// the app in front has a normal window exactly the size of a screen: a presentation, a video, a full-screen app
func frontmostFullscreen() -> Bool {
    guard let app = NSWorkspace.shared.frontmostApplication else { return false }
    if app.bundleIdentifier == "com.apple.finder" { return false }
    let pid = app.processIdentifier
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
    let screens = NSScreen.screens.map { $0.frame }
    for w in list {
        guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid,
              (w[kCGWindowLayer as String] as? Int) == 0,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let width = b["Width"] ?? 0, height = b["Height"] ?? 0
        for s in screens where abs(width - s.width) < 2 && abs(height - s.height) < 2 { return true }
    }
    return false
}

func tick() {
    let line: [String: Bool] = [
        "camera": cameraInUse(),
        "mic": micInUse(),
        "fullscreen": frontmostFullscreen(),
        "sharing": false // covered by camera/mic and by the overlay being invisible to capture
    ]
    if let data = try? JSONSerialization.data(withJSONObject: line), let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}

// exit when Titli goes away
let parent = getppid()
Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
    if getppid() != parent { exit(0) }
    tick()
}
tick()
RunLoop.main.run()
