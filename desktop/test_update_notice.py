"""Exercise the real AppKit update-check path using an isolated fake updater."""
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
HARNESS = r'''
extension ReaderApp {
    func exerciseUpdateNotice() {
        window = NSWindow(contentRect: NSRect(x:0,y:0,width:800,height:600), styleMask:[.titled], backing:.buffered, defer:false)
        installMenus()
        let root = URL(fileURLWithPath: sourcePath)
        let scenario = root.appendingPathComponent("scenario")
        func run(_ name: String) {
            try! name.write(to: scenario, atomically:true, encoding:.utf8)
            performUpdateCheck(silent:true)
            let deadline = Date().addingTimeInterval(10)
            while updateBusy && Date() < deadline { RunLoop.current.run(until:Date().addingTimeInterval(0.02)) }
            precondition(!updateBusy, "Background check hung or opened a modal")
        }
        func calls() -> String { (try? String(contentsOf:root.appendingPathComponent("calls"), encoding:.utf8)) ?? "" }
        run("available")
        precondition(availableUpdate != nil && window.titlebarAccessoryViewControllers.count == 1)
        precondition(updateItem.title == "Update Available…" && updateNoticeButton?.isEnabled == true)
        let before = calls()
        checkForUpdatesSilently()
        precondition(calls() == before && !updateBusy, "Hourly throttle failed")
        updateBusy = true; lastUpdateCheck = Date.distantPast
        checkForUpdatesSilently()
        precondition(calls() == before && updateBusy, "Check overlapped an open confirmation or installation")
        updateBusy = false
        run("offline")
        precondition(availableUpdate != nil && updateItem.isEnabled, "Offline check erased a known update")
        run("malformed")
        precondition(availableUpdate != nil, "Invalid revision erased a known update")
        run("blocked")
        precondition(availableUpdate != nil && window.titlebarAccessoryViewControllers.count == 1)
        run("current")
        precondition(availableUpdate == nil && window.titlebarAccessoryViewControllers.isEmpty)
        precondition(updateItem.title == "Check for Updates…")
        let entries = calls().split(separator:"\n")
        precondition(entries.count == 5)
        precondition(entries.allSatisfy { $0.hasPrefix("--check --json --source ") && !$0.contains("--install") })
        print("Native update notice: available, offline, malformed, blocked, current, throttle, and check-only behavior passed.")
    }
}
let application = NSApplication.shared
let delegate = ReaderApp()
delegate.exerciseUpdateNotice()
'''
FAKE_UPDATER = '''from pathlib import Path
import json, sys
root=Path(__file__).resolve().parent.parent
with (root/'calls').open('a') as stream: stream.write(' '.join(sys.argv[1:])+'\\n')
scenario=(root/'scenario').read_text()
if scenario=='offline': sys.exit(1)
print(json.dumps({'updateAvailable':scenario!='current','canInstall':scenario!='blocked',
'latestCommit':'bad' if scenario=='malformed' else 'a'*40,'latestVersion':'1.0 (99)'}))
'''
with tempfile.TemporaryDirectory(prefix='reader-update-notice-') as directory:
    root = Path(directory)
    (root/'scripts').mkdir()
    (root/'scripts/update-mac.py').write_text(FAKE_UPDATER)
    source = (ROOT/'main.swift').read_text()
    marker = '\nlet application = NSApplication.shared\n'
    assert source.count(marker) == 1
    swift = root/'main.swift'
    swift.write_text(source.split(marker)[0] + HARNESS)
    binary = root/'notice-checks'
    subprocess.run(['xcrun','swiftc','-swift-version','5','-module-cache-path',str(root/'module-cache'),
                    '-framework','AppKit','-framework','WebKit',str(swift),'-o',str(binary)], check=True, timeout=90)
    subprocess.run([str(binary)], env={**os.environ,'LOCAL_READER_SOURCE':str(root)}, check=True, timeout=30)
