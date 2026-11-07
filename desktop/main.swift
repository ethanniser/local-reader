import AppKit
import WebKit

private let readerURL = URL(string: "http://127.0.0.1:8787/")!

final class ReaderApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loading: NSStackView!
    private var message: NSTextField!
    private var retryButton: NSButton!
    private var bootAttempted = false
    private var checkCount = 0
    private var pollTimer: Timer?
    private var generation = 0
    private var request: URLSessionDataTask?
    private var serverLauncher: Process?
    private var updateBusy = false
    private var updateItem: NSMenuItem!
    private var updateTimer: Timer?
    private var lastUpdateCheck: Date?
    private var availableUpdate: [String: Any]?
    private var updateNotice: NSTitlebarAccessoryViewController?
    private var updateNoticeButton: NSButton?
    private var sourcePath: String {
        ProcessInfo.processInfo.environment["LOCAL_READER_SOURCE"]
            ?? Bundle.main.object(forInfoDictionaryKey: "LocalReaderSourcePath") as? String
            ?? ""
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenus()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isHidden = true
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Local Reader"
        window.minSize = NSSize(width: 760, height: 560)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("LocalReaderMain")
        window.center()
        let content = window.contentView!
        webView.frame = content.bounds
        content.addSubview(webView)

        let title = NSTextField(labelWithString: "Local Reader")
        title.font = .systemFont(ofSize: 30, weight: .medium)
        message = NSTextField(wrappingLabelWithString: "Opening your library…")
        message.alignment = .center
        message.textColor = .secondaryLabelColor
        message.preferredMaxLayoutWidth = 520
        retryButton = NSButton(title: "Try again", target: self, action: #selector(retry))
        retryButton.isHidden = true
        loading = NSStackView(views: [title, message, retryButton])
        loading.orientation = .vertical
        loading.spacing = 18
        loading.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(loading)
        NSLayoutConstraint.activate([
            loading.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            loading.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            loading.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -80)
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        retry()
        showUpdateReceipt()
        updateTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.checkForUpdatesSilently() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.checkForUpdatesSilently() }
    }

    private func installMenus() {
        let bar = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Local Reader", action: #selector(showAbout), keyEquivalent: "")
        updateItem = appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Local Reader", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Local Reader", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        bar.addItem(appItem)
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Open Reader Window", action: #selector(showReader), keyEquivalent: "n")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload Reader", action: #selector(reloadReader), keyEquivalent: "r")
        for menu in [file, edit, view] {
            let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
            item.submenu = menu
            bar.addItem(item)
        }
        NSApp.mainMenu = bar
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "Local Reader", .applicationVersion: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))", .credits: NSAttributedString(string: "Your library and speech engines run locally on this Mac.")])
    }

    private func showUpdateReceipt() {
        let receipt = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Local Reader/update-result.json")
        guard let data = try? Data(contentsOf: receipt), data.count < 16384,
              let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let success = result["success"] as? Bool else { return }
        try? FileManager.default.removeItem(at: receipt)
        let detail = success ? (result["message"] as? String ?? "Your app is updated. Your library and settings were preserved.") : (result["error"] as? String ?? "The update could not finish. Your previous version was retained.")
        updateAlert(success ? "Local Reader updated" : "Update needs attention", String(detail.prefix(1000)))
    }

    private func updateAlert(_ title: String, _ detail: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.runModal()
    }

    private func renderUpdateNotice() {
        updateItem.title = updateBusy ? "Checking for Updates…" : availableUpdate == nil ? "Check for Updates…" : "Update Available…"
        updateItem.isEnabled = !updateBusy
        if availableUpdate != nil, updateNotice == nil {
            let button = NSButton(title: "Update available", target: self, action: #selector(checkForUpdates))
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.frame = NSRect(x: 0, y: 0, width: 150, height: 28)
            let accessory = NSTitlebarAccessoryViewController()
            accessory.layoutAttribute = .right
            accessory.view = button
            window.addTitlebarAccessoryViewController(accessory)
            updateNotice = accessory; updateNoticeButton = button
        } else if availableUpdate == nil, let accessory = updateNotice {
            if let index = window.titlebarAccessoryViewControllers.firstIndex(where: { $0 === accessory }) {
                window.removeTitlebarAccessoryViewController(at: index)
            }
            updateNotice = nil; updateNoticeButton = nil
        }
        updateNoticeButton?.isEnabled = !updateBusy
        let version = String((availableUpdate?["latestVersion"] as? String ?? "a newer version").prefix(100))
        updateNoticeButton?.toolTip = "Local Reader \(version) is available. Review the update when you’re ready; playback continues until you choose to install."
    }

    private func checkForUpdatesSilently() {
        guard window != nil, !updateBusy,
              lastUpdateCheck.map({ Date().timeIntervalSince($0) >= 3600 }) ?? true else { return }
        performUpdateCheck(silent: true)
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        checkForUpdatesSilently()
    }

    @objc private func checkForUpdates() { performUpdateCheck(silent: false) }

    private func performUpdateCheck(silent: Bool) {
        guard !updateBusy else { return }
        let source = sourcePath
        let script = URL(fileURLWithPath: source).appendingPathComponent("scripts/update-mac.py").path
        guard FileManager.default.fileExists(atPath: script) else {
            if !silent { updateAlert("Updater unavailable", "The update script is missing from this installation. See the release instructions in your Local Reader source folder.") }
            return
        }
        lastUpdateCheck = Date()
        updateBusy = true; renderUpdateNotice()
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            process.arguments = [script, "--check", "--json", "--source", source]
            process.standardOutput = output; process.standardError = FileHandle.nullDevice
            var value: [String: Any]?
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
                if process.terminationStatus == 0 { value = try JSONSerialization.jsonObject(with: data) as? [String: Any] }
            } catch { }
            DispatchQueue.main.async {
                self.updateBusy = false
                guard let result = value,
                      let updateAvailable = result["updateAvailable"] as? Bool,
                      result["canInstall"] is Bool,
                      let revision = result["latestCommit"] as? String,
                      revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil else {
                    self.renderUpdateNotice()
                    if !silent { self.updateAlert("Could not check for updates", "Check your connection and this Mac’s access to the Local Reader Git repository, then try again.") }
                    return
                }
                self.availableUpdate = updateAvailable ? result : nil
                self.renderUpdateNotice()
                // Background checks end here: never prompt, prepare, or install.
                guard !silent else { return }
                guard result["canInstall"] as? Bool == true else { self.updateAlert("Update needs attention", result["message"] as? String ?? "The source checkout needs attention before updating."); return }
                guard result["updateAvailable"] as? Bool == true else { self.updateAlert("You’re up to date", "This Mac is running the latest available Local Reader source."); return }
                let alert = NSAlert(); alert.messageText = "Install Local Reader update?"
                alert.informativeText = "Update to revision \(revision.prefix(8)). Your library and settings will be preserved. Playback will stop, and the app will reopen when the update finishes."
                alert.addButton(withTitle: "Install and Relaunch"); alert.addButton(withTitle: "Later")
                self.updateBusy = true; self.renderUpdateNotice()
                if alert.runModal() == .alertFirstButtonReturn {
                    self.prepareUpdate(script: script, source: source, revision: revision)
                } else {
                    self.updateBusy = false; self.renderUpdateNotice()
                }
            }
        }
    }

    private func cancelPreparedUpdate() {
        updateBusy = false; renderUpdateNotice()
        webView.evaluateJavaScript("window.localReaderCancelUpdate?.()", completionHandler: nil)
    }

    private func prepareUpdate(script: String, source: String, revision: String) {
        updateBusy = true; renderUpdateNotice()
        webView.callAsyncJavaScript("if (!window.localReaderPrepareUpdate) throw new Error('Reload the reader before updating.'); return await window.localReaderPrepareUpdate();", arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure:
                self.cancelPreparedUpdate()
                self.updateAlert("Finish saving before updating", "Save or close any article or tag edits, and make sure your reading position can sync to the local server. Then try again.")
            case .success(let value):
                guard value as? Bool == true else { self.cancelPreparedUpdate(); self.updateAlert("Update paused", "The reader has not confirmed that your changes are saved."); return }
                do {
                    let data = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Local Reader")
                    let bootstrap = """
                    import pathlib, subprocess, sys
                    log = pathlib.Path(sys.argv[5]) / 'update.log'
                    with log.open('a') as output:
                        subprocess.Popen([sys.executable, sys.argv[1], '--install', '--revision', sys.argv[3], '--parent-pid', sys.argv[4], '--source', sys.argv[2]], stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
                    """
                    let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
                    process.arguments = ["-c", bootstrap, script, source, revision, String(ProcessInfo.processInfo.processIdentifier), data.path]
                    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                    try process.run(); process.waitUntilExit()
                    guard process.terminationStatus == 0 else { self.cancelPreparedUpdate(); self.updateAlert("Update could not start", "Your current app has been kept. Try again after checking the release instructions."); return }
                    NSApp.terminate(nil)
                } catch { self.cancelPreparedUpdate(); self.updateAlert("Update could not start", "Your current app has been kept. Please check the release instructions.") }
            }
        }
    }

    @objc private func showReader() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showReader()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    @objc private func retry() {
        generation += 1
        request?.cancel()
        pollTimer?.invalidate()
        bootAttempted = false
        checkCount = 0
        loading.isHidden = false
        webView.isHidden = true
        retryButton.isHidden = true
        message.stringValue = "Opening your library…"
        checkServer(generation)
    }

    private func checkServer(_ token: Int) {
        guard token == generation else { return }
        var urlRequest = URLRequest(url: readerURL.appendingPathComponent("api/status"))
        urlRequest.timeoutInterval = 1
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, _ in
            let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            let healthy = (response as? HTTPURLResponse)?.statusCode == 200 && object?["local"] as? Bool == true
            DispatchQueue.main.async {
                guard let self = self, token == self.generation else { return }
                if healthy {
                    self.webView.load(URLRequest(url: readerURL))
                    return
                }
                if !self.bootAttempted {
                    self.bootAttempted = true
                    do { try self.startServer() }
                    catch { self.fail(error.localizedDescription); return }
                }
                self.checkCount += 1
                if self.checkCount >= 120 {
                    self.fail("The local server could not start. Check ~/Library/Application Support/Local Reader/server.log, then try again.")
                } else {
                    self.pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in self?.checkServer(token) }
                }
            }
        }
        request?.resume()
    }

    /// LOCAL_READER_PYTHON, else the Python recorded at build time, else the standard venv,
    /// else the venv path used by earlier installs. scripts/update-mac.py resolves it the same way.
    static func pythonExecutable() -> URL {
        let recorded = Bundle.main.object(forInfoDictionaryKey: "LocalReaderPython") as? String
        let environment = ProcessInfo.processInfo.environment["LOCAL_READER_PYTHON"].flatMap { $0.isEmpty ? nil : $0 }
        if let override = environment ?? recorded, !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        }
        let caches = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches", isDirectory: true)
        let current = caches.appendingPathComponent("local-reader/venv/bin/python")
        let legacy = caches.appendingPathComponent("antikythera-local-tts/venv/bin/python")
        let files = FileManager.default
        return !files.fileExists(atPath: current.path) && files.fileExists(atPath: legacy.path) ? legacy : current
    }

    private func startServer() throws {
        let source = ProcessInfo.processInfo.environment["LOCAL_READER_SOURCE"]
            ?? Bundle.main.object(forInfoDictionaryKey: "LocalReaderSourcePath") as? String
            ?? ""
        let root = URL(fileURLWithPath: source, isDirectory: true)
        let python = Self.pythonExecutable()
        guard FileManager.default.isExecutableFile(atPath: python.path),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("server/app.py").path),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("dist/index.html").path) else {
            throw NSError(domain: "LocalReader", code: 1, userInfo: [NSLocalizedDescriptionKey: "Local Reader’s source, frontend build, or Python environment is missing. Run scripts/setup-mac.sh in your Local Reader checkout, then reopen the app."])
        }
        let data = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Local Reader", isDirectory: true)
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        // Keep local speech and sync available when the reader window is closed.
        let bootstrap = """
        import pathlib, subprocess, sys
        log = pathlib.Path(sys.argv[2]) / 'server.log'
        with log.open('a') as output:
            subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', '8787'], cwd=sys.argv[1], stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        """
        let process = Process()
        process.executableURL = python
        process.arguments = ["-c", bootstrap, root.path, data.path]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        serverLauncher = process
        message.stringValue = "Starting your local reader…"
    }

    private func fail(_ detail: String) {
        loading.isHidden = false
        webView.isHidden = true
        message.stringValue = detail
        retryButton.isHidden = false
    }

    @objc private func reloadReader() { retry() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading.isHidden = true
        webView.isHidden = false
        window.makeFirstResponder(webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("Could not open the reader: " + error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == 8787 && url.user == nil && url.password == nil
    }

    private func openExternal(_ url: URL) {
        if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if isLocal(url) {
            if navigationAction.shouldPerformDownload {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
            return
        }
        if navigationAction.navigationType == .linkActivated { openExternal(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isLocal(url) { webView.load(URLRequest(url: url)) }
            else if navigationAction.navigationType == .linkActivated { openExternal(url) }
        }
        return nil
    }
}

let application = NSApplication.shared
let delegate = ReaderApp()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
