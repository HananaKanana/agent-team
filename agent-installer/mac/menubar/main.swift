// ateam 菜单栏程序：屏幕右上角的图标，点开列出项目、启动 / 停止 / 重启服务、打开看板、检查更新。
// 没有窗口、不出现在 Dock（Info.plist 的 LSUIElement）。服务在后台运行，输出写到 <项目>/.ateam/serve.log；
// 退出菜单栏程序不停服务。项目列表在 ~/.config/ateam/projects.json（ateam serve 启动时也会写进去）。
import AppKit

let WRAPPER = "/usr/local/bin/ateam"
let HOME = FileManager.default.homeDirectoryForCurrentUser
let CONFIG_DIR = HOME.appendingPathComponent(".config/ateam")
let PROJECTS = CONFIG_DIR.appendingPathComponent("projects.json")
let LOGIN_ITEM = HOME.appendingPathComponent("Library/LaunchAgents/com.ateam.menubar.plist")
let NO_LOGIN_ITEM = CONFIG_DIR.appendingPathComponent("no-login-item")

struct Status {
    var port: Int?
    var summary: [String: Any]?
    var running: Bool { summary != nil }
    func int(_ key: String) -> Int { (summary?[key] as? NSNumber)?.intValue ?? 0 }
    var attention: Bool { int("accept") > 0 || int("asking") > 0 }
}

// 同步请求本机服务（在后台线程调用）
func httpJSON(_ url: String, post: Bool = false, timeout: TimeInterval = 1.5) -> [String: Any]? {
    guard let u = URL(string: url) else { return nil }
    var req = URLRequest(url: u, timeoutInterval: timeout)
    if post {
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = "{}".data(using: .utf8)
    }
    let sem = DispatchSemaphore(value: 0)
    var out: [String: Any]?
    URLSession.shared.dataTask(with: req) { data, _, _ in
        if let d = data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { out = j }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + timeout + 0.5)
    return out
}

// 运行 ateam 命令，返回（退出码，输出）。在后台线程调用
func runAteam(_ args: [String]) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: WRAPPER)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, "无法运行 \(WRAPPER)：\(error.localizedDescription)") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
func samePath(_ a: String, _ b: String) -> Bool {
    URL(fileURLWithPath: a).resolvingSymlinksInPath().path == URL(fileURLWithPath: b).resolvingSymlinksInPath().path
}

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var item: NSStatusItem!
    let menu = NSMenu()
    var menuOpen = false
    var projects: [String] = []
    var statuses: [String: Status] = [:]
    var busy: [String: String] = [:]          // 项目 → 「启动中…」「停止中…」
    var info: [String: Any] = [:]             // ateam version --check --json
    var updating = false

    func applicationDidFinishLaunching(_ note: Notification) {
        // 只开一个
        if NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").count > 1 {
            NSApp.terminate(nil)
            return
        }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        setIcon(attention: false)
        loadProjects()
        rebuild()
        refreshVersion(check: true, report: false)
        refreshStatuses()
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refreshStatuses() }
        Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.refreshVersion(check: true, report: false) }
    }

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
        loadProjects()
        rebuild()
        refreshStatuses()
    }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false }

    // ---------- 图标：有待验收或待答复时右上角加小红点 ----------
    func setIcon(attention: Bool) {
        let size = NSSize(width: 22, height: 18)
        let symbol = NSImage(systemSymbolName: "person.3.fill", accessibilityDescription: "ateam")
        let image = NSImage(size: size, flipped: false) { rect in
            if let s = symbol {
                let cfg = s.withSymbolConfiguration(.init(pointSize: 13, weight: .regular)) ?? s
                let r = NSRect(x: 0, y: (rect.height - cfg.size.height) / 2, width: cfg.size.width, height: cfg.size.height)
                if attention {
                    // 非模板图：自己按当前外观上色
                    let tinted = NSImage(size: cfg.size, flipped: false) { tr in
                        cfg.draw(in: tr)
                        NSColor.labelColor.set()
                        tr.fill(using: .sourceAtop)
                        return true
                    }
                    tinted.draw(in: r)
                    NSColor.systemRed.setFill()
                    NSBezierPath(ovalIn: NSRect(x: rect.width - 7, y: rect.height - 7, width: 6, height: 6)).fill()
                } else {
                    cfg.draw(in: r)
                }
            }
            return true
        }
        image.isTemplate = !attention
        item.button?.image = image
        item.button?.toolTip = attention ? "ateam：有待处理的事项" : "ateam"
    }

    // ---------- 项目列表 ----------
    func loadProjects() {
        guard let data = try? Data(contentsOf: PROJECTS),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = json["projects"] as? [[String: Any]] else { projects = []; return }
        projects = list.compactMap { $0["path"] as? String }.filter { FileManager.default.fileExists(atPath: $0) }
    }
    func saveProjects(_ paths: [String]) {
        try? FileManager.default.createDirectory(at: CONFIG_DIR, withIntermediateDirectories: true)
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let old = (try? JSONSerialization.jsonObject(with: Data(contentsOf: PROJECTS)) as? [String: Any])?["projects"] as? [[String: Any]] ?? []
        let list: [[String: Any]] = paths.map { p in old.first { ($0["path"] as? String) == p } ?? ["path": p, "lastUsed": now] }
        if let data = try? JSONSerialization.data(withJSONObject: ["projects": list], options: [.prettyPrinted]) {
            try? data.write(to: PROJECTS)
        }
        projects = paths
    }

    func refreshStatuses() {
        let paths = projects
        DispatchQueue.global().async {
            var next: [String: Status] = [:]
            for p in paths {
                var st = Status()
                if let text = try? String(contentsOfFile: p + "/.ateam/port", encoding: .utf8), let port = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    st.port = port
                    if let s = httpJSON("http://127.0.0.1:\(port)/api/summary"), (s["ok"] as? Bool) == true, let root = s["root"] as? String, samePath(root, p) {
                        st.summary = s
                    }
                }
                next[p] = st
            }
            DispatchQueue.main.async {
                self.statuses = next
                self.setIcon(attention: next.values.contains { $0.attention })
                if self.menuOpen { self.rebuild() }
            }
        }
    }

    func refreshVersion(check: Bool, report: Bool) {
        DispatchQueue.global().async {
            let (code, out) = runAteam(check ? ["version", "--check", "--json"] : ["version", "--json"])
            let json = (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any]
            DispatchQueue.main.async {
                if code == 0, let j = json { self.info = j }
                if self.menuOpen { self.rebuild() }
                if report {
                    if let err = json?["error"] as? String { self.alert("检查更新失败", err.replacingOccurrences(of: "检查更新失败：", with: "")) }
                    else if (json?["newer"] as? Bool) == true { self.alert("有新版本 \(json?["latest"] as? String ?? "")", "点击菜单中的「有新版本…」即可更新。") }
                    else if code == 0 { self.alert("已是最新版本", "当前版本 \(json?["version"] as? String ?? "")。") }
                    else { self.alert("检查更新失败", out) }
                }
            }
        }
    }

    // ---------- 菜单 ----------
    func add(_ title: String, _ action: Selector?, _ obj: Any? = nil, to m: NSMenu? = nil, enabled: Bool = true) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: action, keyEquivalent: "")
        it.target = self
        it.representedObject = obj
        it.isEnabled = enabled && action != nil
        (m ?? menu).addItem(it)
        return it
    }

    func dot(_ color: NSColor) -> NSImage {
        let img = NSImage(size: NSSize(width: 10, height: 10), flipped: false) { r in
            color.setFill()
            NSBezierPath(ovalIn: r.insetBy(dx: 1.5, dy: 1.5)).fill()
            return true
        }
        return img
    }

    func rebuild() {
        menu.removeAllItems()
        let version = info["version"] as? String ?? ""
        let mode = info["mode"] as? String ?? ""
        let modeText = mode == "dev" ? " · 开发模式" : mode == "source" ? " · 源码运行" : ""
        _ = add("ateam \(version)\(modeText)", nil, enabled: false)
        menu.addItem(.separator())
        if projects.isEmpty {
            _ = add("还没有项目：点「添加项目…」，或在项目目录运行 ateam", nil, enabled: false)
        }
        for p in projects {
            let st = statuses[p] ?? Status()
            let name = URL(fileURLWithPath: p).lastPathComponent
            var detail = "未运行"
            if let b = busy[p] { detail = b }
            else if st.running {
                var parts = ["运行中", "\(st.int("workers")) 个 worker"]
                if st.int("accept") > 0 { parts.append("\(st.int("accept")) 个待验收") }
                if st.int("asking") > 0 { parts.append("\(st.int("asking")) 个待答复") }
                if (st.summary?["stale"] as? Bool) == true { parts.append("需要重启") }
                detail = parts.joined(separator: " · ")
            }
            let it = NSMenuItem(title: "\(name)    \(detail)", action: nil, keyEquivalent: "")
            it.image = dot(st.running ? (st.attention ? .systemOrange : .systemGreen) : .tertiaryLabelColor)
            it.toolTip = p
            let sub = NSMenu()
            sub.autoenablesItems = false
            let idle = busy[p] == nil
            if st.running {
                _ = add("打开看板", #selector(openDashboard(_:)), p, to: sub)
                _ = add("重启服务", #selector(restart(_:)), p, to: sub, enabled: idle)
                _ = add("停止服务", #selector(stop(_:)), p, to: sub, enabled: idle)
            } else {
                _ = add("启动并打开看板", #selector(start(_:)), p, to: sub, enabled: idle)
            }
            _ = add("查看日志", #selector(showLog(_:)), p, to: sub)
            _ = add("在 Finder 中显示", #selector(reveal(_:)), p, to: sub)
            sub.addItem(.separator())
            _ = add("从列表中移除", #selector(remove(_:)), p, to: sub)
            it.submenu = sub
            menu.addItem(it)
        }
        _ = add("添加项目…", #selector(addProject(_:)))
        menu.addItem(.separator())
        if mode == "installed" {
            if updating { _ = add("正在下载更新…", nil, enabled: false) }
            else if (info["newer"] as? Bool) == true, let latest = info["latest"] as? String {
                _ = add("有新版本 \(latest)，点击更新…", #selector(update(_:)))
            }
            _ = add("检查更新", #selector(checkUpdate(_:)), enabled: !updating)
            menu.addItem(.separator())
        }
        let login = add("登录时自动打开", #selector(toggleLogin(_:)))
        login.state = FileManager.default.fileExists(atPath: LOGIN_ITEM.path) ? .on : .off
        _ = add("退出 ateam 菜单", #selector(quit(_:)))
    }

    // ---------- 动作 ----------
    func port(_ p: String) -> Int? { statuses[p]?.port }

    @objc func openDashboard(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String, let port = port(p), let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        NSWorkspace.shared.open(url)
    }

    // 后台启动：用登录 shell（带上用户的 PATH，git 等命令才找得到），输出追加到 .ateam/serve.log
    @objc func start(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        busy[p] = "启动中…"
        rebuild()
        try? FileManager.default.createDirectory(atPath: p + "/.ateam", withIntermediateDirectories: true)
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-lc", "cd \(shellQuote(p)) && exec /usr/bin/nohup \(WRAPPER) serve >> .ateam/serve.log 2>&1"]
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do { try proc.run() } catch {
            busy[p] = nil
            alert("启动失败", error.localizedDescription)
            return
        }
        waitFor(p, running: true, seconds: 20) { ok in
            self.busy[p] = nil
            if ok, let port = self.port(p), let url = URL(string: "http://127.0.0.1:\(port)/") { NSWorkspace.shared.open(url) }
            else { self.alert("启动失败", "服务没有在 20 秒内启动。日志末尾：\n\n" + self.logTail(p)) }
        }
    }

    @objc func stop(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String, let port = port(p) else { return }
        busy[p] = "停止中…"
        rebuild()
        DispatchQueue.global().async { _ = httpJSON("http://127.0.0.1:\(port)/api/shutdown", post: true) }
        waitFor(p, running: false, seconds: 10) { _ in self.busy[p] = nil; self.rebuild() }
    }

    @objc func restart(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String, let port = port(p) else { return }
        busy[p] = "重启中…"
        rebuild()
        DispatchQueue.global().async { _ = httpJSON("http://127.0.0.1:\(port)/api/restart", post: true) }
        // 先等旧服务停下，再等新服务起来
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            self.waitFor(p, running: true, seconds: 20) { ok in
                self.busy[p] = nil
                if !ok { self.alert("重启失败", "服务没有在 20 秒内重新启动。日志末尾：\n\n" + self.logTail(p)) }
                self.rebuild()
            }
        }
    }

    // 每 0.5 秒查一次状态，直到运行状态符合预期或超时
    func waitFor(_ p: String, running: Bool, seconds: Double, done: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(seconds)
        func tick() {
            DispatchQueue.global().async {
                var st = Status()
                if let text = try? String(contentsOfFile: p + "/.ateam/port", encoding: .utf8), let port = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    st.port = port
                    if let s = httpJSON("http://127.0.0.1:\(port)/api/summary", timeout: 0.8), (s["ok"] as? Bool) == true, let root = s["root"] as? String, samePath(root, p) { st.summary = s }
                }
                DispatchQueue.main.async {
                    self.statuses[p] = st
                    if st.running == running { done(true); self.refreshStatuses(); return }
                    if Date() > deadline { done(false); self.refreshStatuses(); return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: tick)
                }
            }
        }
        tick()
    }

    func logTail(_ p: String) -> String {
        guard let text = try? String(contentsOfFile: p + "/.ateam/serve.log", encoding: .utf8) else { return "（没有日志）" }
        return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(8).joined(separator: "\n")
    }

    @objc func showLog(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        let log = p + "/.ateam/serve.log"
        if !FileManager.default.fileExists(atPath: log) {
            alert("暂无日志", "这个项目的服务还没有从菜单启动过。在终端里启动的服务，输出显示在那个终端窗口里。")
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = ["-a", "Console", log]
        try? proc.run()
    }

    @objc func reveal(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
    }

    @objc func remove(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        saveProjects(projects.filter { $0 != p })
        rebuild()
    }

    @objc func addProject(_ sender: NSMenuItem) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "选择要用 ateam 开发的项目目录（项目根目录）"
        panel.prompt = "添加"
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let path = url.path
        saveProjects([path] + projects.filter { !samePath($0, path) })
        refreshStatuses()
    }

    @objc func update(_ sender: NSMenuItem) {
        updating = true
        rebuild()
        DispatchQueue.global().async {
            let (code, out) = runAteam(["update"])
            DispatchQueue.main.async {
                self.updating = false
                self.rebuild()
                // 成功时系统安装程序已经打开，不再弹框
                if code != 0 { self.alert("更新失败", out.replacingOccurrences(of: "错误：", with: "")) }
            }
        }
    }

    @objc func checkUpdate(_ sender: NSMenuItem) { refreshVersion(check: true, report: true) }

    @objc func toggleLogin(_ sender: NSMenuItem) {
        let fm = FileManager.default
        try? fm.createDirectory(at: CONFIG_DIR, withIntermediateDirectories: true)
        if fm.fileExists(atPath: LOGIN_ITEM.path) {
            try? fm.removeItem(at: LOGIN_ITEM)
            fm.createFile(atPath: NO_LOGIN_ITEM.path, contents: Data())
        } else {
            try? fm.createDirectory(at: LOGIN_ITEM.deletingLastPathComponent(), withIntermediateDirectories: true)
            let plist = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>Label</key><string>com.ateam.menubar</string>
              <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>/Applications/ateam.app</string></array>
              <key>RunAtLoad</key><true/>
            </dict>
            </plist>

            """
            try? plist.write(to: LOGIN_ITEM, atomically: true, encoding: .utf8)
            try? fm.removeItem(at: NO_LOGIN_ITEM)
        }
        rebuild()
    }

    @objc func quit(_ sender: NSMenuItem) { NSApp.terminate(nil) }

    func alert(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
