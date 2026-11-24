// ateam 菜单栏程序：屏幕右上角的图标，点开列出项目、启动 / 停止 / 重启服务、打开看板、检查更新。
// 没有窗口、不出现在 Dock（Info.plist 的 LSUIElement）。服务在后台运行，输出写到 <项目>/.ateam/serve.log；
// 退出菜单栏程序不停服务。项目列表在 ~/.config/ateam/projects.json（ateam serve 启动时也会写进去）。
// 菜单顶部列出各项目待你处理的事（与看板「待处理」一致），点了在浏览器里直达；新出现的事发系统通知。
import AppKit
import IOKit.pwr_mgt
import UserNotifications

let WRAPPER = "/usr/local/bin/ateam"
let HOME = FileManager.default.homeDirectoryForCurrentUser
let CONFIG_DIR = HOME.appendingPathComponent(".config/ateam")
let PROJECTS = CONFIG_DIR.appendingPathComponent("projects.json")
let LOGIN_ITEM = HOME.appendingPathComponent("Library/LaunchAgents/com.ateam.menubar.plist")
let NO_LOGIN_ITEM = CONFIG_DIR.appendingPathComponent("no-login-item")
let GITHUB = "https://github.com/HananaKanana/agent-team"  // 与 src/update.js 的 REPO 一致

struct Status {
    var port: Int?
    var summary: [String: Any]?
    var running: Bool { summary != nil }
    func int(_ key: String) -> Int { (summary?[key] as? NSNumber)?.intValue ?? 0 }
    // 待你处理的事：[{ key, text, hash }]
    var items: [[String: Any]] { summary?["items"] as? [[String: Any]] ?? [] }
    var agents: [[String: Any]] { summary?["agents"] as? [[String: Any]] ?? [] }
    var lan: [String] { summary?["lan"] as? [String] ?? [] }
    var spawn: [String: Any] { summary?["spawn"] as? [String: Any] ?? [:] }
    var attention: Bool { !items.isEmpty }
    func url(_ hash: String = "") -> URL? {
        guard let port = port else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/" + (hash.isEmpty ? "" : "#" + hash))
    }
}

// 通知开关，默认开
let NOTIFY_KEY = "notify"
// VS Code（找不到就不显示「在 VS Code 中打开」）
func vscodeURL() -> URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") }
func notifyOn() -> Bool { UserDefaults.standard.object(forKey: NOTIFY_KEY) as? Bool ?? true }
// 有进行中的任务时阻止系统休眠（默认开）
let AWAKE_KEY = "keepAwake"
func awakeOn() -> Bool { UserDefaults.standard.object(forKey: AWAKE_KEY) as? Bool ?? true }

func ago(_ ms: Double?) -> String {
    guard let ms = ms else { return "" }
    let min = Int((Date().timeIntervalSince1970 * 1000 - ms) / 60000)
    if min < 1 { return "刚开始" }
    if min < 60 { return "\(min) 分钟" }
    return "\(min / 60) 小时 \(min % 60) 分钟"
}

// 同步请求本机服务（在后台线程调用）
func httpJSON(_ url: String, post: Bool = false, body: [String: Any] = [:], timeout: TimeInterval = 1.5) -> [String: Any]? {
    guard let u = URL(string: url) else { return nil }
    var req = URLRequest(url: u, timeoutInterval: timeout)
    if post {
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
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

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    var item: NSStatusItem!
    let menu = NSMenu()
    var menuOpen = false
    // 阻止休眠的电源断言（和 caffeinate -i 相同：系统不因空闲休眠，屏幕照常熄灭）。退出程序时系统自动释放
    var sleepAssertion: IOPMAssertionID = 0
    var keepingAwake = false
    var workingTotal = 0
    var projects: [String] = []
    var statuses: [String: Status] = [:]
    var busy: [String: String] = [:]          // 项目 → 「启动中…」「停止中…」
    var info: [String: Any] = [:]             // ateam version --check --json
    var updating = false
    // 通知：一件事持续 1 分钟才通知（掉线马上重连之类的不打扰），同一件事只通知一次；程序启动时已经存在的不通知
    var firstSeen: [String: Date] = [:]
    var notified: Set<String> = []
    var baselined = false

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
        UNUserNotificationCenter.current().delegate = self
        registerNotifyActions()
        if notifyOn() { requestNotify() }
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
        refreshVersion(check: false, report: false)  // 切换开发模式 / 安装版后，打开菜单即显示新的模式
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
                self.workingTotal = next.values.reduce(0) { $0 + $1.int("working") }
                self.updateAwake()
                self.setIcon(attention: next.values.contains { $0.attention })
                self.notifyNew()
                if self.menuOpen { self.rebuild() }
            }
        }
    }

    func refreshVersion(check: Bool, report: Bool) {
        DispatchQueue.global().async {
            let (code, out) = runAteam(check ? ["version", "--check", "--json"] : ["version", "--json"])
            let json = (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any]
            DispatchQueue.main.async {
                // 不查更新时只合并版本和模式，保留上次查到的新版本信息
                if code == 0, let j = json { if check { self.info = j } else { self.info.merge(j) { _, new in new } } }
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

    // 菜单顶部：粗体 ateam、版本号，开发模式 / 源码运行用橙色标出；正在阻止休眠时第二行写明。
    // 用自定义视图：禁用的普通菜单项整行发灰，看着像不可用的选项
    func headerItem(version: String, mode: String) -> NSMenuItem {
        let title = NSMutableAttributedString(string: "ateam", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: NSColor.labelColor])
        if !version.isEmpty {
            title.append(NSAttributedString(string: "  \(version)", attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.secondaryLabelColor]))
        }
        if mode == "dev" || mode == "source" {
            title.append(NSAttributedString(string: "  \(mode == "dev" ? "开发模式" : "源码运行")", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.systemOrange]))
        }
        var rows: [NSView] = [NSTextField(labelWithAttributedString: title)]
        if keepingAwake {
            let line = NSTextField(labelWithString: "正在阻止休眠 · \(workingTotal) 个任务进行中")
            line.font = .systemFont(ofSize: 11)
            line.textColor = .secondaryLabelColor
            rows.append(line)
        }
        let stack = NSStackView(views: rows)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 3, left: 14, bottom: 3, right: 14)
        stack.frame = NSRect(origin: .zero, size: NSSize(width: max(220, stack.fittingSize.width), height: stack.fittingSize.height))
        stack.autoresizingMask = [.width]
        let it = NSMenuItem()
        it.view = stack
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
        menu.addItem(headerItem(version: version, mode: mode))
        menu.addItem(.separator())
        // 待处理：各项目待你处理的事，点了直达看板上的那个需求或那张卡
        let pending = projects.flatMap { p -> [(String, [String: Any])] in (statuses[p]?.items ?? []).map { (p, $0) } }
        if !pending.isEmpty {
            _ = add("待处理（\(pending.count)）", nil, enabled: false)
            for (p, item) in pending.prefix(12) {
                let name = URL(fileURLWithPath: p).lastPathComponent
                let text = item["text"] as? String ?? ""
                let short = text.count > 40 ? String(text.prefix(40)) + "…" : text
                let it = add("\(projects.count > 1 ? name + " · " : "")\(short)", #selector(openURL(_:)), statuses[p]?.url(item["hash"] as? String ?? "")?.absoluteString)
                it.toolTip = text
                it.indentationLevel = 1
            }
            if pending.count > 12 { _ = add("还有 \(pending.count - 12) 项，请在看板中查看", nil, enabled: false) }
            menu.addItem(.separator())
        }
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
                if st.int("working") > 0 { parts.append("\(st.int("working")) 张进行中") }
                if !st.items.isEmpty { parts.append("\(st.items.count) 项待处理") }
                detail = parts.joined(separator: " · ")
            }
            // 用带颜色的圆点字符：菜单项的图片在部分系统版本上不显示
            let it = NSMenuItem(title: "\(name)    \(detail)", action: nil, keyEquivalent: "")
            let color: NSColor = st.running ? (st.attention ? .systemOrange : .systemGreen) : .tertiaryLabelColor
            let title = NSMutableAttributedString(string: "● ", attributes: [.foregroundColor: color, .font: NSFont.menuFont(ofSize: 0)])
            title.append(NSAttributedString(string: name, attributes: [.font: NSFont.menuFont(ofSize: 0)]))
            title.append(NSAttributedString(string: "    \(detail)", attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.menuFont(ofSize: 0)]))
            it.attributedTitle = title
            // 路径不做悬停提示（会盖住子菜单），放在子菜单第一行
            let sub = NSMenu()
            sub.autoenablesItems = false
            _ = add((p as NSString).abbreviatingWithTildeInPath, nil, to: sub, enabled: false)
            sub.addItem(.separator())
            let idle = busy[p] == nil
            if st.running {
                _ = add("打开看板", #selector(openURL(_:)), st.url()?.absoluteString, to: sub)
                _ = add("重启服务", #selector(restart(_:)), p, to: sub, enabled: idle)
                _ = add("停止服务", #selector(stop(_:)), p, to: sub, enabled: idle)
                // 服务是旧版本（摘要里没有这些字段）：不显示 worker 等信息，免得显示成「没有」
                let fresh = st.summary?["items"] != nil
                if !fresh {
                    sub.addItem(.separator())
                    _ = add("服务仍在运行旧版本，重启服务后显示 worker 等信息", nil, to: sub, enabled: false)
                }
                // 在线 worker 和手上的卡：点了直达那张卡
                if fresh {
                    sub.addItem(.separator())
                    _ = add(st.agents.isEmpty ? "没有在线的 worker" : "在线 worker（\(st.agents.count)）", nil, to: sub, enabled: false)
                }
                for a in (fresh ? st.agents : []) {
                    let id = a["id"] as? String ?? ""
                    let label = (a["name"] as? String).map { "\(id)（\($0)）" } ?? id
                    let task = a["task"] as? [String: Any]
                    var text = label
                    if let t = task {
                        text += " · \(t["id"] as? String ?? "")"
                        if (a["stale"] as? Bool) == true { text += " · 无响应" }
                        else if let since = (t["since"] as? NSNumber)?.doubleValue { text += " · 已做 \(ago(since))" }
                    } else { text += " · 空闲" }
                    if (a["dismiss"] as? Bool) == true { text += " · 将下线" }
                    // 每个 worker 一个子菜单：打开它的卡、发消息、下线（与看板「worker」页的按钮相同）
                    let w = add(text, nil, to: sub)
                    w.isEnabled = true
                    w.toolTip = task?["title"] as? String
                    w.indentationLevel = 1
                    w.submenu = workerMenu(p, a)
                }
                // 按角色启动 worker：与看板「worker」页的「启动」按钮相同，在设置里选的平台中新建会话
                let roles = st.spawn["roles"] as? [[String: Any]] ?? []
                if fresh && !roles.isEmpty {
                    let spawnMenu = NSMenu()
                    spawnMenu.autoenablesItems = false
                    for r in roles {
                        let role = r["role"] as? String ?? ""
                        var text = role
                        if let label = r["label"] as? String { text += " · \(label)" }
                        if (r["needed"] as? Bool) == true { text += "（缺少 worker）" }
                        let n = (r["online"] as? NSNumber)?.intValue ?? 0
                        if n > 0 { text += " · 在线 \(n) 个" }
                        _ = add(text, #selector(spawnWorker(_:)), ["path": p, "role": role], to: spawnMenu, enabled: idle)
                    }
                    let si = NSMenuItem(title: "启动 worker（\(st.spawn["platform"] as? String ?? "")）", action: nil, keyEquivalent: "")
                    si.submenu = spawnMenu
                    sub.addItem(si)
                }
                // 局域网访问状态
                if fresh {
                    sub.addItem(.separator())
                    _ = add(st.lan.isEmpty ? "局域网访问：未开启" : "局域网访问：已开启（只读）", nil, to: sub, enabled: false)
                }
            } else {
                _ = add("启动并打开看板", #selector(start(_:)), p, to: sub, enabled: idle)
            }
            sub.addItem(.separator())
            if vscodeURL() != nil { _ = add("在 VS Code 中打开", #selector(openInVSCode(_:)), p, to: sub) }
            _ = add("在终端中打开", #selector(openInTerminal(_:)), p, to: sub)
            _ = add("查看日志", #selector(showLog(_:)), p, to: sub)
            _ = add("在 Finder 中显示", #selector(reveal(_:)), p, to: sub)
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
        // 帮助与反馈：GitHub 上的使用说明、版本记录和问题反馈
        let help = NSMenuItem(title: "帮助与反馈", action: nil, keyEquivalent: "")
        let hsub = NSMenu()
        _ = add("使用说明", #selector(openURL(_:)), "\(GITHUB)#readme", to: hsub)
        _ = add("版本记录", #selector(openURL(_:)), "\(GITHUB)/releases", to: hsub)
        _ = add("反馈问题", #selector(openURL(_:)), "\(GITHUB)/issues/new", to: hsub)
        hsub.addItem(.separator())
        _ = add("GitHub 主页", #selector(openURL(_:)), GITHUB, to: hsub)
        help.submenu = hsub
        // 设置：几个开关收在一个子菜单里
        let settings = NSMenuItem(title: "设置", action: nil, keyEquivalent: "")
        let ssub = NSMenu()
        ssub.autoenablesItems = false
        let awake = add("有进行中的任务时阻止休眠", #selector(toggleAwake(_:)), to: ssub)
        awake.state = awakeOn() ? .on : .off
        awake.toolTip = "任一项目有进行中的任务时，系统不会因空闲而休眠（屏幕照常熄灭、锁屏）；任务全部完成后自动恢复。合上笔记本盖子时仍会休眠。"
        let notify = add("新的待处理事项发送系统通知", #selector(toggleNotify(_:)), to: ssub)
        notify.state = notifyOn() ? .on : .off
        let login = add("登录时自动打开", #selector(toggleLogin(_:)), to: ssub)
        login.state = FileManager.default.fileExists(atPath: LOGIN_ITEM.path) ? .on : .off
        settings.submenu = ssub
        menu.addItem(settings)
        menu.addItem(help)
        menu.addItem(.separator())
        _ = add("退出 ateam 菜单", #selector(quit(_:)))
    }

    // 一个在线 worker 的子菜单
    func workerMenu(_ p: String, _ a: [String: Any]) -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false
        let id = a["id"] as? String ?? ""
        let task = a["task"] as? [String: Any]
        let tid = task?["id"] as? String ?? ""
        let critic = (a["role"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased() == "critic"
        let info: [String: Any] = ["path": p, "id": id, "task": tid, "last": (a["last"] as? Bool) == true, "role": a["role"] as? String ?? ""]
        if let t = task {
            _ = add("打开 \(tid)", #selector(openURL(_:)), statuses[p]?.url(t["hash"] as? String ?? "")?.absoluteString, to: m)
        }
        _ = add("发消息…", #selector(messageWorker(_:)), info, to: m)
        m.addItem(.separator())
        if (a["dismiss"] as? Bool) == true {
            _ = add(critic ? "已安排审核完成后下线" : "已安排做完当前任务后下线", nil, to: m, enabled: false)
            _ = add("撤销，继续领取任务", #selector(keepWorker(_:)), info, to: m)
            _ = add("立即下线", #selector(dismissNow(_:)), info, to: m)
        } else if critic {
            _ = add("审核完成后下线", #selector(dismissLater(_:)), info, to: m)
            _ = add("立即下线", #selector(dismissNow(_:)), info, to: m)
        } else if task != nil {
            _ = add("做完 \(tid) 后下线", #selector(dismissLater(_:)), info, to: m)
            _ = add("立即下线（\(tid) 退回待领取）", #selector(dismissNow(_:)), info, to: m)
        } else {
            _ = add("下线", #selector(dismissNow(_:)), info, to: m)
        }
        return m
    }

    func workerPost(_ info: [String: Any], _ path: String, _ body: [String: Any], _ failTitle: String) {
        guard let p = info["path"] as? String, let port = port(p) else { return }
        DispatchQueue.global().async {
            let out = httpJSON("http://127.0.0.1:\(port)\(path)", post: true, body: body, timeout: 5)
            DispatchQueue.main.async {
                if out == nil { self.alert(failTitle, "无法连接该项目的 ateam 服务。") }
                else if (out?["ok"] as? Bool) != true { self.alert(failTitle, out?["message"] as? String ?? "未知错误") }
                self.refreshStatuses()
            }
        }
    }

    // 确认框：返回是否继续
    func confirm(_ title: String, _ text: String, _ ok: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.addButton(withTitle: ok)
        a.addButton(withTitle: "取消")
        return a.runModal() == .alertFirstButtonReturn
    }

    func lastNote(_ info: [String: Any]) -> String {
        (info["last"] as? Bool) == true ? "\n\n它是 \(info["role"] as? String ?? "") 角色唯一在线的 worker，下线后该角色的新任务将无人领取。" : ""
    }

    @objc func dismissLater(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: Any], let id = info["id"] as? String else { return }
        if (info["last"] as? Bool) == true, !confirm("让 \(id) 完成后下线？", lastNote(info).trimmingCharacters(in: .whitespacesAndNewlines), "完成后下线") { return }
        workerPost(info, "/api/dismiss", ["ids": [id], "userApproved": true, "afterTask": true], "下线失败")
    }

    @objc func dismissNow(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: Any], let id = info["id"] as? String else { return }
        let tid = info["task"] as? String ?? ""
        let text = (tid.isEmpty ? "\(id) 将立即下线。" : "\(id) 将立即停止，\(tid) 退回待领取，由其他 worker 接手。") + lastNote(info)
        if !confirm("让 \(id) 立即下线？", text, "立即下线") { return }
        workerPost(info, "/api/dismiss", ["ids": [id], "userApproved": true], "下线失败")
    }

    @objc func keepWorker(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: Any], let id = info["id"] as? String else { return }
        workerPost(info, "/api/agents/keep", ["ids": [id]], "撤销失败")
    }

    @objc func messageWorker(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: Any], let id = info["id"] as? String else { return }
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "发消息给 \(id)"
        a.informativeText = "它会在当前操作结束后（启用了工具后 hook 时）或下一次调用 ateam 时看到。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 60))
        field.placeholderString = "要对它说的话"
        a.accessoryView = field
        a.addButton(withTitle: "发送")
        a.addButton(withTitle: "取消")
        a.window.initialFirstResponder = field
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        workerPost(info, "/api/message", ["to": id, "text": text, "by": "user"], "发送失败")
    }

    // ---------- 动作 ----------
    func port(_ p: String) -> Int? { statuses[p]?.port }

    @objc func openURL(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String, let url = URL(string: text) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func spawnWorker(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: String], let p = info["path"], let role = info["role"], let port = port(p) else { return }
        DispatchQueue.global().async {
            let out = httpJSON("http://127.0.0.1:\(port)/api/spawn", post: true, body: ["role": role, "by": "user"], timeout: 30)
            DispatchQueue.main.async {
                guard let out = out else { self.alert("启动 worker 失败", "无法连接该项目的 ateam 服务。"); return }
                if (out["ok"] as? Bool) != true { self.alert("启动 worker 失败", out["message"] as? String ?? "未知错误"); return }
                var lines: [String] = []
                if let note = out["note"] as? String { lines.append(note) }
                if (out["over"] as? Bool) == true, let max = (out["max"] as? NSNumber)?.intValue { lines.append("当前在线 worker 已超过设置的上限 \(max) 个。") }
                if !lines.isEmpty { self.alert("已启动 \(role) worker", lines.joined(separator: "\n\n")) }
                self.refreshStatuses()
            }
        }
    }

    @objc func openInVSCode(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String, let app = vscodeURL() else { return }
        NSWorkspace.shared.open([URL(fileURLWithPath: p)], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
    }

    @objc func openInTerminal(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = ["-a", "Terminal", p]
        try? proc.run()
    }


    // ---------- 系统通知 ----------
    func requestNotify() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func notifyNew() {
        var current: [String: (String, String, URL?, [String: Any]?, String)] = [:]   // key → (项目名, 文字, 直达地址, 可执行的操作, 项目目录)
        for p in projects {
            guard let st = statuses[p], st.running else { continue }
            for item in st.items {
                guard let key = item["key"] as? String else { continue }
                current["\(p)|\(key)"] = (URL(fileURLWithPath: p).lastPathComponent, item["text"] as? String ?? "", st.url(item["hash"] as? String ?? ""), item["act"] as? [String: Any], p)
            }
        }
        // 程序刚启动时已经存在的事不通知
        if !baselined {
            baselined = true
            notified = Set(current.keys)
        }
        let now = Date()
        for k in Array(firstSeen.keys) where current[k] == nil { firstSeen[k] = nil; notified.remove(k) }
        for k in Array(notified) where current[k] == nil { notified.remove(k) }
        for (k, v) in current where !notified.contains(k) {
            let first = firstSeen[k] ?? now
            firstSeen[k] = first
            guard now.timeIntervalSince(first) >= 60 else { continue }
            notified.insert(k)
            guard notifyOn() else { continue }
            let content = UNMutableNotificationContent()
            content.title = "ateam · \(v.0)"
            content.body = v.1
            content.sound = .default
            var info: [String: Any] = ["key": k, "path": v.4]
            if let u = v.2 { info["url"] = u.absoluteString }
            if let act = v.3, let type = act["type"] as? String {
                info["act"] = act
                content.categoryIdentifier = "ateam.\(type)"
                if type == "accept", let job = act["job"] as? String, let u = statuses[v.4]?.url("\(job)/report") { info["report"] = u.absoluteString }
            } else {
                content.categoryIdentifier = "ateam.open"
            }
            content.userInfo = info
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: k, content: content, trigger: nil))
        }
    }

    // 通知上的按钮。macOS 的横幅通知把按钮收在「选项」里；在「系统设置 → 通知 → ateam」把样式改成「提醒」，按钮会一直显示
    func registerNotifyActions() {
        let snooze = UNNotificationAction(identifier: "snooze", title: "30 分钟后再提醒")
        let cat = { (id: String, actions: [UNNotificationAction]) in UNNotificationCategory(identifier: id, actions: actions + [snooze], intentIdentifiers: []) }
        UNUserNotificationCenter.current().setNotificationCategories([
            cat("ateam.accept", [UNNotificationAction(identifier: "accept", title: "验收通过"), UNNotificationAction(identifier: "report", title: "查看汇报", options: [.foreground])]),
            cat("ateam.spawn", [UNNotificationAction(identifier: "spawn", title: "启动 worker")]),
            cat("ateam.reclaim", [UNNotificationAction(identifier: "reclaim", title: "收回任务", options: [.destructive])]),
            cat("ateam.restart", [UNNotificationAction(identifier: "restart", title: "重启服务")]),
            cat("ateam.open", []),
        ])
    }

    // 点通知本身：在浏览器里直达；点按钮：直接执行
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let open = { (key: String) in if let text = info[key] as? String, let url = URL(string: text) { NSWorkspace.shared.open(url) } }
        let act = info["act"] as? [String: Any] ?? [:]
        let path = info["path"] as? String ?? ""
        let key = info["key"] as? String ?? ""
        DispatchQueue.main.async {
            switch response.actionIdentifier {
            case "accept":
                guard let job = act["job"] as? String else { break }
                self.notifyAct(path, "/api/jobs/accept", ["ids": [job]], "\(job) 已验收通过", "验收失败")
            case "report": open("report")
            case "spawn":
                guard let role = act["role"] as? String else { break }
                self.notifyAct(path, "/api/spawn", ["role": role, "by": "user"], "已启动 \(role) worker", "启动 worker 失败", timeout: 30)
            case "reclaim":
                guard let task = act["task"] as? String else { break }
                self.notifyAct(path, "/api/reclaim", ["id": task, "text": "用户从通知收回"], "\(task) 已收回，退回待领取", "收回任务失败")
            case "restart":
                self.notifyAct(path, "/api/restart", [:], "服务正在重启", "重启失败")
            case "snooze":
                // 30 分钟后事情还在就再通知一次
                DispatchQueue.main.asyncAfter(deadline: .now() + 30 * 60) {
                    self.notified.remove(key)
                    self.firstSeen[key] = Date(timeIntervalSinceNow: -60)
                    self.notifyNew()
                }
            case UNNotificationDismissActionIdentifier: break
            default: open("url")
            }
            done()
        }
    }

    // 通知按钮的操作：成功时发一条简短的确认通知，失败时弹框
    func notifyAct(_ p: String, _ path: String, _ body: [String: Any], _ okText: String, _ failTitle: String, timeout: TimeInterval = 5) {
        guard let port = port(p) else { alert(failTitle, "该项目的 ateam 服务没有在运行。"); return }
        DispatchQueue.global().async {
            let out = httpJSON("http://127.0.0.1:\(port)\(path)", post: true, body: body, timeout: timeout)
            DispatchQueue.main.async {
                if out == nil { self.alert(failTitle, "无法连接该项目的 ateam 服务。") }
                else if (out?["ok"] as? Bool) != true { self.alert(failTitle, out?["message"] as? String ?? "未知错误") }
                else {
                    let c = UNMutableNotificationContent()
                    c.title = "ateam · \(URL(fileURLWithPath: p).lastPathComponent)"
                    c.body = okText
                    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
                }
                self.refreshStatuses()
            }
        }
    }
    // 程序在前台时也显示
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    func updateAwake() {
        let want = awakeOn() && workingTotal > 0
        if want && !keepingAwake {
            var id: IOPMAssertionID = 0
            let r = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "ateam：有进行中的任务" as CFString, &id)
            if r == kIOReturnSuccess { sleepAssertion = id; keepingAwake = true }
        } else if !want && keepingAwake {
            IOPMAssertionRelease(sleepAssertion)
            keepingAwake = false
        }
    }

    @objc func toggleAwake(_ sender: NSMenuItem) {
        UserDefaults.standard.set(!awakeOn(), forKey: AWAKE_KEY)
        updateAwake()
        rebuild()
    }

    @objc func toggleNotify(_ sender: NSMenuItem) {
        let on = !notifyOn()
        UserDefaults.standard.set(on, forKey: NOTIFY_KEY)
        if on { requestNotify() }
        rebuild()
    }

    // 后台启动：用登录 shell（带上用户的 PATH，git 等命令才找得到），输出追加到 .ateam/serve.log
    // 正在运行的话返回端口（同步发请求，不要在主线程调用）
    func runningPort(_ p: String) -> Int? {
        guard let text = try? String(contentsOfFile: p + "/.ateam/port", encoding: .utf8), let port = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        guard let s = httpJSON("http://127.0.0.1:\(port)/api/summary"), (s["ok"] as? Bool) == true, let root = s["root"] as? String, samePath(root, p) else { return nil }
        return port
    }

    @objc func start(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        busy[p] = "启动中…"
        rebuild()
        // 菜单里的状态可能是旧的（比如刚好在重启的间隙刷新到「未运行」）：先确认一次，已在运行就直接打开看板，不再启动第二个
        DispatchQueue.global().async {
            let running = self.runningPort(p)
            DispatchQueue.main.async {
                if let port = running {
                    self.busy[p] = nil
                    self.refreshStatuses()
                    if let url = URL(string: "http://127.0.0.1:\(port)/") { NSWorkspace.shared.open(url) }
                    return
                }
                self.launch(p)
            }
        }
    }

    func launch(_ p: String) {
        try? FileManager.default.createDirectory(atPath: p + "/.ateam", withIntermediateDirectories: true)
        let from = logMark(p)
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
            else { self.alert("启动失败", "服务没有在 20 秒内启动。本次启动的日志：\n\n" + self.logTail(p, from: from)) }
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
        let from = logMark(p)
        DispatchQueue.global().async { _ = httpJSON("http://127.0.0.1:\(port)/api/restart", post: true) }
        // 先等旧服务停下，再等新服务起来
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            self.waitFor(p, running: true, seconds: 20) { ok in
                self.busy[p] = nil
                if !ok { self.alert("重启失败", "服务没有在 20 秒内重新启动。本次重启的日志：\n\n" + self.logTail(p, from: from)) }
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

    // serve.log 每次启动都往后追加：启动前记下长度，失败时只显示这之后新写的（不然弹窗里大半是以前几次运行的旧日志）。
    // 超过 2MB 先改名成 serve.log.old（只留一份），免得越积越大
    func logMark(_ p: String) -> UInt64 {
        let log = p + "/.ateam/serve.log"
        let size = ((try? FileManager.default.attributesOfItem(atPath: log))?[.size] as? NSNumber)?.uint64Value ?? 0
        if size > 2 * 1024 * 1024 {
            try? FileManager.default.removeItem(atPath: log + ".old")
            try? FileManager.default.moveItem(atPath: log, toPath: log + ".old")
            return 0
        }
        return size
    }

    func logTail(_ p: String, from: UInt64 = 0) -> String {
        guard let h = FileHandle(forReadingAtPath: p + "/.ateam/serve.log") else { return "（没有日志）" }
        defer { h.closeFile() }
        h.seek(toFileOffset: from)
        let text = String(decoding: h.readDataToEndOfFile(), as: UTF8.self)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).suffix(12)
        return lines.isEmpty ? "（没有输出）" : lines.joined(separator: "\n")
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
