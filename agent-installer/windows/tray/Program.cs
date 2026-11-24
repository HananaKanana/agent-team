// ateam 的 Windows 托盘程序：屏幕右下角通知区域的图标（和 Mac 的 agent-installer/mac/menubar/main.swift 对应）。
// 点开列出项目、启动 / 停止 / 重启服务、打开看板、在线 worker、待处理事项、检查更新。没有窗口。
//
//   ateam.exe                托盘程序（只开一个）
//   ateam.exe --uninstall    卸载（「设置 → 应用」里点卸载走的就是它），--quiet 不弹确认
//
// 服务在后台运行（经 cmd.exe 把输出追加到 <项目>\.ateam\serve.log），退出托盘程序不停服务。
// 项目列表在 %USERPROFILE%\.config\ateam\projects.json（ateam serve 启动时也会写进去）。
// 托盘自己的开关（通知、阻止休眠）存在 HKCU\Software\ateam；开机自启是 HKCU\...\Run 的 ateam 一项（和 src/install.js 一致）。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Ateam
{
    internal static class Paths
    {
        public static string InstallDir => Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        public static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        public static string ConfigDir => Path.Combine(Home, ".config", "ateam");
        public static string Projects => Path.Combine(ConfigDir, "projects.json");
        public static string NoLoginItem => Path.Combine(ConfigDir, "no-login-item");
        public const string Github = "https://github.com/HananaKanana/agent-team";  // 与 src/update.js 的 REPO 一致

        /// <summary>安装目录里的 node：node\<版本>\node.exe（版本号由 build.sh 编进程序集）</summary>
        public static string Node
        {
            get
            {
                var meta = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "NodeVersion")?.Value;
                var exact = meta == null ? null : Path.Combine(InstallDir, "node", meta, "node.exe");
                if (exact != null && File.Exists(exact)) return exact;
                try
                {
                    return Directory.GetDirectories(Path.Combine(InstallDir, "node")).Select(d => Path.Combine(d, "node.exe")).Where(File.Exists).OrderByDescending(f => f).FirstOrDefault() ?? exact;
                }
                catch
                {
                    return exact;
                }
            }
        }

        /// <summary>和 ateam.cmd 同样的规则：开发模式（~/.config/ateam/dev-repo）用仓库里的代码，否则用安装目录里的</summary>
        public static string Script
        {
            get
            {
                try
                {
                    var repo = File.ReadAllLines(Path.Combine(ConfigDir, "dev-repo")).FirstOrDefault()?.Trim();
                    if (!string.IsNullOrEmpty(repo) && File.Exists(Path.Combine(repo, "bin", "ateam.js"))) return Path.Combine(repo, "bin", "ateam.js");
                }
                catch { }
                return Path.Combine(InstallDir, "app", "bin", "ateam.js");
            }
        }
    }

    internal static class Json
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        public static Dictionary<string, object> Parse(string text)
        {
            try { return Serializer.DeserializeObject(text) as Dictionary<string, object>; } catch { return null; }
        }
        public static string Write(object value) => Serializer.Serialize(value);
        public static string Str(this Dictionary<string, object> d, string key) => d != null && d.TryGetValue(key, out var v) && v is string s ? s : null;
        public static bool Bool(this Dictionary<string, object> d, string key) => d != null && d.TryGetValue(key, out var v) && v is bool b && b;
        public static int Int(this Dictionary<string, object> d, string key)
        {
            if (d == null || !d.TryGetValue(key, out var v) || v == null) return 0;
            try { return Convert.ToInt32(v); } catch { return 0; }
        }
        public static double? Num(this Dictionary<string, object> d, string key)
        {
            if (d == null || !d.TryGetValue(key, out var v) || v == null) return null;
            try { return Convert.ToDouble(v); } catch { return null; }
        }
        public static Dictionary<string, object> Obj(this Dictionary<string, object> d, string key) => d != null && d.TryGetValue(key, out var v) ? v as Dictionary<string, object> : null;
        public static List<Dictionary<string, object>> List(this Dictionary<string, object> d, string key)
        {
            if (d == null || !d.TryGetValue(key, out var v) || !(v is IEnumerable e) || v is string) return new List<Dictionary<string, object>>();
            return e.OfType<Dictionary<string, object>>().ToList();
        }
        public static List<string> Strings(this Dictionary<string, object> d, string key)
        {
            if (d == null || !d.TryGetValue(key, out var v) || !(v is IEnumerable e) || v is string) return new List<string>();
            return e.OfType<string>().ToList();
        }
    }

    internal static class Http
    {
        /// <summary>同步请求本机服务（在后台线程调用），失败返回 null</summary>
        public static Dictionary<string, object> Call(string url, bool post = false, object body = null, int timeoutMs = 1500)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;   // 本机地址，不走系统代理
                if (post)
                {
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    var data = Encoding.UTF8.GetBytes(Json.Write(body ?? new Dictionary<string, object>()));
                    using (var s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                }
                using (var res = GetResponse(req))
                using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    return Json.Parse(reader.ReadToEnd());
                }
            }
            catch
            {
                return null;
            }
        }

        // 4xx / 5xx 也读出 JSON（服务把错误原因写在 message 里）
        private static WebResponse GetResponse(HttpWebRequest req)
        {
            try { return req.GetResponse(); }
            catch (WebException e) when (e.Response != null) { return e.Response; }
        }
    }

    internal sealed class Status
    {
        public int? Port;
        public Dictionary<string, object> Summary;
        public bool Running => Summary != null;
        public List<Dictionary<string, object>> Items => Summary.List("items");
        public List<Dictionary<string, object>> Agents => Summary.List("agents");
        public bool Attention => Running && Items.Count > 0;
        public string Url(string hash = "") => Port == null ? null : "http://127.0.0.1:" + Port + "/" + (string.IsNullOrEmpty(hash) ? "" : "#" + hash);
    }

    internal static class Program
    {
        private const string MutexName = @"Local\ateam-tray";

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Contains("--uninstall")) return Uninstaller.Run(args.Contains("--quiet"));
            using (var mutex = new Mutex(true, MutexName, out var created))
            {
                if (!created) return 0;   // 只开一个
                Application.Run(new Tray());
            }
            return 0;
        }

        /// <summary>运行 ateam 子命令（node + ateam.js），返回（退出码，输出）。在后台线程调用</summary>
        public static (int, string) RunAteam(string args, int timeoutMs = 180000)
        {
            try
            {
                var info = new ProcessStartInfo(Paths.Node, "\"" + Paths.Script + "\" " + args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = Path.GetTempPath(),
                };
                using (var p = Process.Start(info))
                {
                    var err = p.StandardError.ReadToEndAsync();
                    var output = p.StandardOutput.ReadToEnd();
                    if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } return (-1, "ateam " + args + " 超时"); }
                    return (p.ExitCode, (output + err.Result).Trim());
                }
            }
            catch (Exception e)
            {
                return (-1, "无法运行 ateam：" + e.Message);
            }
        }

        public static void Open(string target)
        {
            if (string.IsNullOrEmpty(target)) return;
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
        }

        public static bool SamePath(string a, string b)
        {
            try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        public static Status ReadStatus(string p, int timeoutMs = 1500)
        {
            var st = new Status();
            try
            {
                var text = File.ReadAllText(Path.Combine(p, ".ateam", "port")).Trim();
                if (int.TryParse(text, out var port))
                {
                    st.Port = port;
                    var s = Http.Call("http://127.0.0.1:" + port + "/api/summary", timeoutMs: timeoutMs);
                    var root = s.Str("root");
                    if (s.Bool("ok") && root != null && SamePath(root, p)) st.Summary = s;
                }
            }
            catch { }
            return st;
        }
    }

    // ------------------------------------------------------------------ 托盘

    internal sealed class Tray : ApplicationContext
    {
        private readonly NotifyIcon icon;
        private readonly ContextMenuStrip menu = new ContextMenuStrip();
        private readonly Control ui = new Control();
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 15000 };
        private readonly System.Windows.Forms.Timer versionTimer = new System.Windows.Forms.Timer { Interval = 6 * 3600 * 1000 };
        private readonly Icon baseIcon;
        private Icon attentionIcon;
        private List<string> projects = new List<string>();
        private Dictionary<string, Status> statuses = new Dictionary<string, Status>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> busy = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // 项目 → 「启动中…」
        private Dictionary<string, object> info = new Dictionary<string, object>();   // ateam version --check --json
        private bool updating;
        private bool keepingAwake;
        private int workingTotal;
        // 通知：一件事持续 1 分钟才通知，同一件事只通知一次；程序启动时已经存在的不通知
        private readonly Dictionary<string, DateTime> firstSeen = new Dictionary<string, DateTime>();
        private readonly HashSet<string> notified = new HashSet<string>();
        private bool baselined;
        private string balloonUrl;
        private readonly Font bold;
        private Image headImage;

        public Tray()
        {
            _ = ui.Handle;   // 先建好句柄，后台线程才能 BeginInvoke 回来
            try { baseIcon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { baseIcon = SystemIcons.Application; }
            // 菜单样式：接近 Windows 11 原生菜单（见 MenuTheme / ModernRenderer），跟随系统的深浅色
            ToolStripManager.Renderer = new ModernRenderer();
            menu.Font = new Font("Microsoft YaHei UI", 9.5F);
            menu.Padding = new Padding(0, 4, 0, 4);
            bold = new Font(menu.Font, FontStyle.Bold);
            icon = new NotifyIcon { Icon = baseIcon, Text = "ateam", Visible = true, ContextMenuStrip = menu };
            menu.ShowImageMargin = true;
            menu.HandleCreated += (s, e) => MenuTheme.RoundCorners(menu);
            menu.Opening += (s, e) =>
            {
                MenuTheme.Refresh();
                menu.BackColor = MenuTheme.Back;
                LoadProjects();
                Rebuild();
                e.Cancel = false;
                RefreshStatuses();
                RefreshVersion(false, false);
            };
            // 左键单击也弹出菜单（和右键一样）
            icon.MouseUp += (s, e) =>
            {
                if (e.Button != MouseButtons.Left) return;
                typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic)?.Invoke(icon, null);
            };
            icon.BalloonTipClicked += (s, e) => Program.Open(balloonUrl);
            timer.Tick += (s, e) => RefreshStatuses();
            versionTimer.Tick += (s, e) => RefreshVersion(true, false);
            LoadProjects();
            Rebuild();
            RefreshVersion(true, false);
            RefreshStatuses();
            timer.Start();
            versionTimer.Start();
        }

        protected override void ExitThreadCore()
        {
            icon.Visible = false;
            icon.Dispose();
            SetAwake(false);
            base.ExitThreadCore();
        }

        private void OnUi(Action action)
        {
            try { ui.BeginInvoke(action); } catch { }
        }

        // ---------- 设置（HKCU\Software\ateam）----------
        private static bool Setting(string name, bool def)
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\ateam"))
            {
                var v = key?.GetValue(name);
                return v == null ? def : Convert.ToInt32(v) != 0;
            }
        }
        private static void SetSetting(string name, bool on)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(@"Software\ateam")) key.SetValue(name, on ? 1 : 0, RegistryValueKind.DWord);
        }
        private static bool NotifyOn => Setting("notify", true);
        private static bool AwakeOn => Setting("keepAwake", true);

        private static bool LoginItemOn
        {
            get { using (var run = Registry.CurrentUser.OpenSubKey(Installation.RunKey)) return run?.GetValue(Installation.RunValue) != null; }
        }

        // ---------- 项目列表 ----------
        private void LoadProjects()
        {
            try
            {
                var json = Json.Parse(File.ReadAllText(Paths.Projects, Encoding.UTF8));
                projects = json.List("projects").Select(p => p.Str("path")).Where(p => p != null && Directory.Exists(p)).ToList();
            }
            catch
            {
                projects = new List<string>();
            }
        }

        private void SaveProjects(List<string> paths)
        {
            List<Dictionary<string, object>> old;
            try { old = Json.Parse(File.ReadAllText(Paths.Projects, Encoding.UTF8)).List("projects"); } catch { old = new List<Dictionary<string, object>>(); }
            var now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            var list = paths.Select(p => old.FirstOrDefault(o => o.Str("path") == p) ?? new Dictionary<string, object> { ["path"] = p, ["lastUsed"] = now }).ToList();
            Directory.CreateDirectory(Paths.ConfigDir);
            File.WriteAllText(Paths.Projects, Json.Write(new Dictionary<string, object> { ["projects"] = list }) + "\n", new UTF8Encoding(false));
            projects = paths;
        }

        private void RefreshStatuses()
        {
            var paths = projects.ToList();
            Task.Run(() =>
            {
                var next = new Dictionary<string, Status>(StringComparer.OrdinalIgnoreCase);
                foreach (var p in paths) next[p] = Program.ReadStatus(p);
                OnUi(() =>
                {
                    statuses = next;
                    workingTotal = next.Values.Sum(s => s.Summary.Int("working"));
                    UpdateAwake();
                    SetIcon(next.Values.Any(s => s.Attention));
                    NotifyNew();
                });
            });
        }

        private void RefreshVersion(bool check, bool report)
        {
            Task.Run(() =>
            {
                var (code, output) = Program.RunAteam(check ? "version --check --json" : "version --json");
                var json = Json.Parse(output);
                OnUi(() =>
                {
                    // 不查更新时只合并版本和模式，保留上次查到的新版本信息
                    if (code == 0 && json != null)
                    {
                        if (check) info = json;
                        else foreach (var kv in json) info[kv.Key] = kv.Value;
                    }
                    if (!report) return;
                    if (json.Str("error") != null) Alert("检查更新失败", json.Str("error").Replace("检查更新失败：", ""));
                    else if (json.Bool("newer")) Alert("有新版本 " + json.Str("latest"), "点击托盘菜单中的「有新版本…」即可更新。");
                    else if (code == 0) Alert("已是最新版本", "当前版本 " + json.Str("version") + "。");
                    else Alert("检查更新失败", output);
                });
            });
        }

        // ---------- 图标：有待处理的事时右上角加小红点 ----------
        private void SetIcon(bool attention)
        {
            if (attention && attentionIcon == null)
            {
                using (var bmp = new Bitmap(32, 32))
                {
                    using (var g = Graphics.FromImage(bmp))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.DrawIcon(new Icon(baseIcon, 32, 32), new Rectangle(0, 0, 32, 32));
                        g.FillEllipse(Brushes.White, 18, 0, 14, 14);
                        g.FillEllipse(new SolidBrush(Color.FromArgb(230, 60, 50)), 20, 2, 10, 10);
                    }
                    attentionIcon = Icon.FromHandle(bmp.GetHicon());
                }
            }
            icon.Icon = attention ? attentionIcon : baseIcon;
            icon.Text = attention ? "ateam：有待处理的事项" : "ateam";
        }

        // ---------- 菜单 ----------
        private ToolStripMenuItem Add(ToolStripItemCollection to, string text, Action action = null, bool enabled = true)
        {
            var it = new ToolStripMenuItem(text) { Enabled = enabled && action != null };
            if (action != null) it.Click += (s, e) => action();
            to.Add(it);
            return it;
        }

        private ToolStripMenuItem Label(ToolStripItemCollection to, string text)
        {
            var it = new ToolStripMenuItem(text) { Enabled = false };
            to.Add(it);
            return it;
        }

        private static Image Dot(Color color)
        {
            var bmp = new Bitmap(16, 16);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var b = new SolidBrush(color)) g.FillEllipse(b, 4, 4, 8, 8);
            }
            return bmp;
        }

        private static string Short(string text, int n) => text.Length > n ? text.Substring(0, n) + "…" : text;

        private static string Ago(double? ms)
        {
            if (ms == null) return "";
            var min = (int)(((DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds - ms.Value) / 60000);
            if (min < 1) return "刚开始";
            if (min < 60) return min + " 分钟";
            return min / 60 + " 小时 " + min % 60 + " 分钟";
        }

        private string Name(string p) => Path.GetFileName(p.TrimEnd('\\'));

        private void Rebuild()
        {
            menu.SuspendLayout();
            foreach (ToolStripItem it in menu.Items.Cast<ToolStripItem>().ToList()) it.Dispose();
            menu.Items.Clear();
            var items = menu.Items;

            // 顶部：ateam 和版本号；开发模式 / 源码运行标出来；正在阻止休眠时写明
            var version = info.Str("version") ?? "";
            var mode = info.Str("mode") ?? "";
            var sub0 = version + (mode == "dev" ? "  开发模式" : mode == "source" ? "  源码运行" : "");
            var head = new ToolStripMenuItem("ateam    " + sub0)
            {
                Image = headImage ?? (headImage = new Icon(baseIcon, 16, 16).ToBitmap()),
                Tag = new TwoTone("ateam", sub0, true, true),
            };
            items.Add(head);
            if (keepingAwake) Label(items, "正在阻止休眠 · " + workingTotal + " 个任务进行中");
            items.Add(new ToolStripSeparator());

            // 待处理：各项目待你处理的事，点了直达看板上的那个需求或那张卡
            var pending = projects.SelectMany(p => (statuses.TryGetValue(p, out var s) && s.Running ? s.Items : new List<Dictionary<string, object>>()).Select(i => (p, i))).ToList();
            if (pending.Count > 0)
            {
                Label(items, "待处理（" + pending.Count + "）");
                foreach (var (p, item) in pending.Take(12))
                {
                    var text = item.Str("text") ?? "";
                    var url = statuses[p].Url(item.Str("hash"));
                    var it = Add(items, "    " + (projects.Count > 1 ? Name(p) + " · " : "") + Short(text, 40), () => Program.Open(url));
                    it.ToolTipText = text;
                }
                if (pending.Count > 12) Label(items, "还有 " + (pending.Count - 12) + " 项，请在看板中查看");
                items.Add(new ToolStripSeparator());
            }

            if (projects.Count == 0) Label(items, "还没有项目：点「添加项目…」，或在项目目录运行 ateam");
            foreach (var p in projects)
            {
                statuses.TryGetValue(p, out var st);
                st = st ?? new Status();
                var detail = "未运行";
                if (busy.TryGetValue(p, out var b)) detail = b;
                else if (st.Running)
                {
                    var parts = new List<string> { "运行中", st.Summary.Int("workers") + " 个 worker" };
                    if (st.Summary.Int("working") > 0) parts.Add(st.Summary.Int("working") + " 张进行中");
                    if (st.Items.Count > 0) parts.Add(st.Items.Count + " 项待处理");
                    detail = string.Join(" · ", parts);
                }
                var it = new ToolStripMenuItem(Name(p) + "      " + detail)
                {
                    Tag = new TwoTone(Name(p), detail),
                    Image = Dot(st.Running ? (st.Attention ? Color.DarkOrange : Color.FromArgb(40, 170, 80)) : Color.Silver),
                };
                var sub = it.DropDownItems;
                Label(sub, p);
                sub.Add(new ToolStripSeparator());
                var idle = !busy.ContainsKey(p);
                if (st.Running)
                {
                    var home = st.Url();
                    Add(sub, "打开看板", () => Program.Open(home));
                    Add(sub, "重启服务", () => Restart(p), idle);
                    Add(sub, "停止服务", () => Stop(p), idle);
                    // 在线 worker 和手上的卡
                    sub.Add(new ToolStripSeparator());
                    var agents = st.Agents;
                    Label(sub, agents.Count == 0 ? "没有在线的 worker" : "在线 worker（" + agents.Count + "）");
                    foreach (var a in agents) sub.Add(WorkerItem(p, st, a));
                    // 按角色启动 worker（与看板「worker」页的「启动」按钮相同）
                    var spawn = st.Summary.Obj("spawn");
                    var roles = spawn.List("roles");
                    if (roles.Count > 0)
                    {
                        var si = new ToolStripMenuItem("启动 worker（" + (spawn.Str("platform") ?? "") + "）");
                        foreach (var r in roles)
                        {
                            var role = r.Str("role") ?? "";
                            var text = role;
                            if (r.Str("label") != null) text += " · " + r.Str("label");
                            if (r.Bool("needed")) text += "（缺少 worker）";
                            if (r.Int("online") > 0) text += " · 在线 " + r.Int("online") + " 个";
                            Add(si.DropDownItems, text, () => SpawnWorker(p, role), idle);
                        }
                        sub.Add(si);
                    }
                    sub.Add(new ToolStripSeparator());
                    Label(sub, st.Summary.Strings("lan").Count == 0 ? "局域网访问：未开启" : "局域网访问：已开启（只读）");
                }
                else
                {
                    Add(sub, "启动并打开看板", () => Start(p), idle);
                }
                sub.Add(new ToolStripSeparator());
                var code = VsCode();
                if (code != null) Add(sub, "在 VS Code 中打开", () => Run(code, "\"" + p + "\""));
                Add(sub, "在终端中打开", () => OpenTerminal(p));
                Add(sub, "查看日志", () => ShowLog(p));
                Add(sub, "在资源管理器中显示", () => Run("explorer.exe", "\"" + p + "\""));
                Add(sub, "从列表中移除", () => SaveProjects(projects.Where(x => x != p).ToList()));
                items.Add(it);
            }
            Add(items, "添加项目…", AddProject);
            items.Add(new ToolStripSeparator());

            if (mode == "installed")
            {
                if (updating) Label(items, "正在下载更新…");
                else if (info.Bool("newer") && info.Str("latest") != null) Add(items, "有新版本 " + info.Str("latest") + "，点击更新…", Update);
                Add(items, "检查更新", () => RefreshVersion(true, true), !updating);
                items.Add(new ToolStripSeparator());
            }

            var settings = new ToolStripMenuItem("设置");
            var awake = Add(settings.DropDownItems, "有进行中的任务时阻止休眠", () => { SetSetting("keepAwake", !AwakeOn); UpdateAwake(); });
            awake.Checked = AwakeOn;
            awake.ToolTipText = "任一项目有进行中的任务时，系统不会因空闲而睡眠（屏幕照常关闭、锁屏）；任务全部完成后自动恢复。合上笔记本盖子时仍会睡眠。";
            Add(settings.DropDownItems, "新的待处理事项发送系统通知", () => SetSetting("notify", !NotifyOn)).Checked = NotifyOn;
            Add(settings.DropDownItems, "开机后自动打开", ToggleLogin).Checked = LoginItemOn;
            items.Add(settings);

            var help = new ToolStripMenuItem("帮助与反馈");
            Add(help.DropDownItems, "使用说明", () => Program.Open(Paths.Github + "#readme"));
            Add(help.DropDownItems, "版本记录", () => Program.Open(Paths.Github + "/releases"));
            Add(help.DropDownItems, "反馈问题", () => Program.Open(Paths.Github + "/issues/new"));
            help.DropDownItems.Add(new ToolStripSeparator());
            Add(help.DropDownItems, "GitHub 主页", () => Program.Open(Paths.Github));
            items.Add(help);
            items.Add(new ToolStripSeparator());
            Add(items, "退出 ateam 托盘", () => ExitThread());
            MenuTheme.Style(menu.Items);
            menu.ResumeLayout();
        }

        // 一个在线 worker：打开它的卡、发消息、下线（与看板「worker」页的按钮相同）
        private ToolStripMenuItem WorkerItem(string p, Status st, Dictionary<string, object> a)
        {
            var id = a.Str("id") ?? "";
            var task = a.Obj("task");
            var tid = task.Str("id") ?? "";
            var text = a.Str("name") != null ? id + "（" + a.Str("name") + "）" : id;
            if (task != null)
            {
                text += " · " + tid;
                if (a.Bool("stale")) text += " · 无响应";
                else if (task.Num("since") != null) text += " · 已做 " + Ago(task.Num("since"));
            }
            else text += " · 空闲";
            if (a.Bool("dismiss")) text += " · 将下线";
            var w = new ToolStripMenuItem("    " + text) { ToolTipText = task.Str("title") };
            var m = w.DropDownItems;
            var critic = (a.Str("role") ?? "").Trim().ToLowerInvariant() == "critic";
            var last = a.Bool("last") ? "\n\n它是 " + a.Str("role") + " 角色唯一在线的 worker，下线后该角色的新任务将无人领取。" : "";
            if (task != null)
            {
                var url = st.Url(task.Str("hash"));
                Add(m, "打开 " + tid, () => Program.Open(url));
            }
            Add(m, "发消息…", () => MessageWorker(p, id));
            m.Add(new ToolStripSeparator());
            Action later = () =>
            {
                if (a.Bool("last") && !Confirm("让 " + id + " 完成后下线？", last.Trim())) return;
                WorkerPost(p, "/api/dismiss", new Dictionary<string, object> { ["ids"] = new[] { id }, ["userApproved"] = true, ["afterTask"] = true }, "下线失败");
            };
            Action now = () =>
            {
                var t = (tid == "" ? id + " 将立即下线。" : id + " 将立即停止，" + tid + " 退回待领取，由其他 worker 接手。") + last;
                if (!Confirm("让 " + id + " 立即下线？", t)) return;
                WorkerPost(p, "/api/dismiss", new Dictionary<string, object> { ["ids"] = new[] { id }, ["userApproved"] = true }, "下线失败");
            };
            if (a.Bool("dismiss"))
            {
                Label(m, critic ? "已安排审核完成后下线" : "已安排做完当前任务后下线");
                Add(m, "撤销，继续领取任务", () => WorkerPost(p, "/api/agents/keep", new Dictionary<string, object> { ["ids"] = new[] { id } }, "撤销失败"));
                Add(m, "立即下线", now);
            }
            else if (critic)
            {
                Add(m, "审核完成后下线", later);
                Add(m, "立即下线", now);
            }
            else if (task != null)
            {
                Add(m, "做完 " + tid + " 后下线", later);
                Add(m, "立即下线（" + tid + " 退回待领取）", now);
            }
            else Add(m, "下线", now);
            return w;
        }

        private int? Port(string p) => statuses.TryGetValue(p, out var s) ? s.Port : null;

        private void WorkerPost(string p, string path, Dictionary<string, object> body, string failTitle, string okText = null, int timeoutMs = 5000)
        {
            var port = Port(p);
            if (port == null) { Alert(failTitle, "该项目的 ateam 服务没有在运行。"); return; }
            Task.Run(() =>
            {
                var output = Http.Call("http://127.0.0.1:" + port + path, true, body, timeoutMs);
                OnUi(() =>
                {
                    if (output == null) Alert(failTitle, "无法连接该项目的 ateam 服务。");
                    else if (!output.Bool("ok")) Alert(failTitle, output.Str("message") ?? "未知错误");
                    else if (okText != null) Balloon(Name(p), okText, null);
                    RefreshStatuses();
                });
            });
        }

        private void MessageWorker(string p, string id)
        {
            using (var form = new InputForm("发消息给 " + id, "它会在当前操作结束后（启用了工具后 hook 时）或下一次调用 ateam 时看到。"))
            {
                if (form.ShowDialog() != DialogResult.OK) return;
                var text = form.Value.Trim();
                if (text == "") return;
                WorkerPost(p, "/api/message", new Dictionary<string, object> { ["to"] = id, ["text"] = text, ["by"] = "user" }, "发送失败");
            }
        }

        private void SpawnWorker(string p, string role)
        {
            var port = Port(p);
            if (port == null) return;
            Task.Run(() =>
            {
                var output = Http.Call("http://127.0.0.1:" + port + "/api/spawn", true, new Dictionary<string, object> { ["role"] = role, ["by"] = "user" }, 30000);
                OnUi(() =>
                {
                    if (output == null) { Alert("启动 worker 失败", "无法连接该项目的 ateam 服务。"); return; }
                    if (!output.Bool("ok")) { Alert("启动 worker 失败", output.Str("message") ?? "未知错误"); return; }
                    var lines = new List<string>();
                    if (output.Str("note") != null) lines.Add(output.Str("note"));
                    if (output.Bool("over")) lines.Add("当前在线 worker 已超过设置的上限 " + output.Int("max") + " 个。");
                    if (lines.Count > 0) Alert("已启动 " + role + " worker", string.Join("\n\n", lines));
                    RefreshStatuses();
                });
            });
        }

        // ---------- 启动 / 停止 / 重启 ----------
        private void Start(string p)
        {
            busy[p] = "启动中…";
            // 状态可能是旧的（比如刚好在重启的间隙刷新到「未运行」）：先确认一次，已在运行就直接打开看板，不再启动第二个
            Task.Run(() =>
            {
                var st = Program.ReadStatus(p);
                OnUi(() =>
                {
                    if (st.Running) { busy.Remove(p); RefreshStatuses(); Program.Open(st.Url()); return; }
                    Launch(p);
                });
            });
        }

        // 后台启动：经 cmd.exe 把输出追加到 .ateam\serve.log。cmd 不开窗口，托盘退出后服务继续运行
        private void Launch(string p)
        {
            var from = LogMark(p);
            try
            {
                Directory.CreateDirectory(Path.Combine(p, ".ateam"));
                var command = "/d /c \"\"" + Paths.Node + "\" \"" + Paths.Script + "\" serve >> \".ateam\\serve.log\" 2>&1\"";
                Process.Start(new ProcessStartInfo("cmd.exe", command) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = p });
            }
            catch (Exception e)
            {
                busy.Remove(p);
                Alert("启动失败", e.Message);
                return;
            }
            WaitFor(p, true, 20, ok =>
            {
                busy.Remove(p);
                if (ok) Program.Open(statuses.TryGetValue(p, out var s) ? s.Url() : null);
                else Alert("启动失败", "服务没有在 20 秒内启动。本次启动的日志：\n\n" + LogTail(p, from));
            });
        }

        private void Stop(string p)
        {
            var port = Port(p);
            if (port == null) return;
            busy[p] = "停止中…";
            Task.Run(() => Http.Call("http://127.0.0.1:" + port + "/api/shutdown", true));
            WaitFor(p, false, 10, _ => busy.Remove(p));
        }

        private void Restart(string p)
        {
            var port = Port(p);
            if (port == null) return;
            busy[p] = "重启中…";
            var from = LogMark(p);
            Task.Run(() =>
            {
                Http.Call("http://127.0.0.1:" + port + "/api/restart", true);
                Thread.Sleep(1500);   // 先等旧服务停下，再等新服务起来
                OnUi(() => WaitFor(p, true, 20, ok =>
                {
                    busy.Remove(p);
                    if (!ok) Alert("重启失败", "服务没有在 20 秒内重新启动。本次重启的日志：\n\n" + LogTail(p, from));
                }));
            });
        }

        // 每 0.5 秒查一次状态，直到运行状态符合预期或超时
        private void WaitFor(string p, bool running, int seconds, Action<bool> done)
        {
            var deadline = DateTime.Now.AddSeconds(seconds);
            Task.Run(() =>
            {
                while (true)
                {
                    var st = Program.ReadStatus(p, 800);
                    var ok = st.Running == running;
                    if (ok || DateTime.Now > deadline)
                    {
                        OnUi(() => { statuses[p] = st; done(ok); RefreshStatuses(); });
                        return;
                    }
                    Thread.Sleep(500);
                }
            });
        }

        // serve.log 每次启动都往后追加：启动前记下长度，失败时只显示这之后新写的（不然弹窗里大半是以前几次运行的旧日志）。
        // 超过 2MB 先改名成 serve.log.old（只留一份），免得越积越大
        private static long LogMark(string p)
        {
            var log = Path.Combine(p, ".ateam", "serve.log");
            long size;
            try { size = new FileInfo(log).Length; } catch { return 0; }
            if (size <= 2 * 1024 * 1024) return size;
            // 服务还开着这个文件（重启时）就改不了名：这次照常往后接着读，下次停着的时候再换
            try
            {
                File.Delete(log + ".old");
                File.Move(log, log + ".old");
                return 0;
            }
            catch
            {
                return size;
            }
        }

        private static string LogTail(string p, long from = 0)
        {
            try
            {
                using (var fs = new FileStream(Path.Combine(p, ".ateam", "serve.log"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    fs.Seek(Math.Min(from, fs.Length), SeekOrigin.Begin);
                    using (var reader = new StreamReader(fs, Encoding.UTF8))
                    {
                        var lines = reader.ReadToEnd().Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
                        return lines.Length == 0 ? "（没有输出）" : string.Join("\n", lines.Skip(Math.Max(0, lines.Length - 12)));
                    }
                }
            }
            catch
            {
                return "（没有日志）";
            }
        }

        private void ShowLog(string p)
        {
            var log = Path.Combine(p, ".ateam", "serve.log");
            if (!File.Exists(log)) { Alert("暂无日志", "这个项目的服务还没有从托盘启动过。在终端里启动的服务，输出显示在那个终端窗口里。"); return; }
            Run("notepad.exe", "\"" + log + "\"");
        }

        private static void Run(string file, string args)
        {
            try { Process.Start(new ProcessStartInfo(file, args) { UseShellExecute = true }); } catch { }
        }

        private static string VsCode()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            return new[] { Path.Combine(local, "Programs", "Microsoft VS Code", "Code.exe"), Path.Combine(pf, "Microsoft VS Code", "Code.exe") }.FirstOrDefault(File.Exists);
        }

        // Windows Terminal 有就用它，没有就开 cmd
        private static void OpenTerminal(string p)
        {
            try
            {
                Process.Start(new ProcessStartInfo("wt.exe", "-d \"" + p + "\"") { UseShellExecute = true });
            }
            catch
            {
                try { Process.Start(new ProcessStartInfo("cmd.exe") { UseShellExecute = true, WorkingDirectory = p }); } catch { }
            }
        }

        private void AddProject()
        {
            using (var dialog = new FolderBrowserDialog { Description = "选择要用 ateam 开发的项目目录（项目根目录）", ShowNewFolderButton = false })
            {
                if (dialog.ShowDialog() != DialogResult.OK) return;
                var path = dialog.SelectedPath;
                SaveProjects(new[] { path }.Concat(projects.Where(x => !Program.SamePath(x, path))).ToList());
                RefreshStatuses();
            }
        }

        private void Update()
        {
            updating = true;
            Task.Run(() =>
            {
                // 成功时安装程序会退掉本程序、换好文件后重新打开，不再弹框
                var (code, output) = Program.RunAteam("update", 600000);
                OnUi(() =>
                {
                    updating = false;
                    if (code != 0) Alert("更新失败", output.Replace("错误：", ""));
                });
            });
        }

        private void ToggleLogin()
        {
            Directory.CreateDirectory(Paths.ConfigDir);
            using (var run = Registry.CurrentUser.CreateSubKey(Installation.RunKey))
            {
                if (run.GetValue(Installation.RunValue) != null)
                {
                    run.DeleteValue(Installation.RunValue, false);
                    File.WriteAllText(Paths.NoLoginItem, "");
                }
                else
                {
                    run.SetValue(Installation.RunValue, "\"" + Assembly.GetExecutingAssembly().Location + "\"");
                    try { File.Delete(Paths.NoLoginItem); } catch { }
                }
            }
        }

        // ---------- 阻止休眠 ----------
        [DllImport("kernel32.dll")]
        private static extern uint SetThreadExecutionState(uint flags);
        private const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001;

        private void UpdateAwake() => SetAwake(AwakeOn && workingTotal > 0);

        // 只阻止系统因空闲睡眠，屏幕照常关闭。设置在 UI 线程上，程序退出时系统自动解除
        private void SetAwake(bool want)
        {
            if (want == keepingAwake) return;
            SetThreadExecutionState(want ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED : ES_CONTINUOUS);
            keepingAwake = want;
        }

        // ---------- 通知（托盘气泡，Windows 10 / 11 上显示为系统通知）----------
        private void NotifyNew()
        {
            var current = new Dictionary<string, (string name, string text, string url)>();
            foreach (var p in projects)
            {
                if (!statuses.TryGetValue(p, out var st) || !st.Running) continue;
                foreach (var item in st.Items)
                {
                    var key = item.Str("key");
                    if (key == null) continue;
                    current[p + "|" + key] = (Name(p), item.Str("text") ?? "", st.Url(item.Str("hash")));
                }
            }
            if (!baselined)
            {
                baselined = true;
                foreach (var k in current.Keys) notified.Add(k);
            }
            var now = DateTime.Now;
            foreach (var k in firstSeen.Keys.ToList()) if (!current.ContainsKey(k)) { firstSeen.Remove(k); notified.Remove(k); }
            notified.RemoveWhere(k => !current.ContainsKey(k));
            foreach (var kv in current)
            {
                if (notified.Contains(kv.Key)) continue;
                if (!firstSeen.TryGetValue(kv.Key, out var first)) firstSeen[kv.Key] = first = now;
                if ((now - first).TotalSeconds < 60) continue;
                notified.Add(kv.Key);
                if (NotifyOn) Balloon(kv.Value.name, kv.Value.text, kv.Value.url);
            }
        }

        private void Balloon(string project, string text, string url)
        {
            balloonUrl = url;
            icon.ShowBalloonTip(8000, "ateam · " + project, text, ToolTipIcon.None);
        }

        private static bool Confirm(string title, string text) =>
            MessageBox.Show(text, title, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;

        private static void Alert(string title, string text) =>
            MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    // ------------------------------------------------------------------ 菜单样式

    /// <summary>一行两种颜色：前半（项目名、ateam）正常色，后半（运行状态、版本号）灰色。Static 的行不高亮、点了没反应</summary>
    internal sealed class TwoTone
    {
        public readonly string Main, Sub;
        public readonly bool Bold, Static;
        public TwoTone(string main, string sub, bool bold = false, bool isStatic = false) { Main = main; Sub = sub; Bold = bold; Static = isStatic; }
    }

    /// <summary>菜单配色：跟随「设置 → 个性化 → 颜色 → 选择默认应用模式」的深浅色</summary>
    internal static class MenuTheme
    {
        public static bool Dark;
        public static Color Back, Hover, Fore, Gray, Sep, Border;

        static MenuTheme() { Refresh(); }

        public static void Refresh()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    Dark = key?.GetValue("AppsUseLightTheme") is int v && v == 0;
            }
            catch { Dark = false; }
            Back = Dark ? Color.FromArgb(44, 44, 44) : Color.FromArgb(249, 249, 249);
            Hover = Dark ? Color.FromArgb(61, 61, 61) : Color.FromArgb(234, 234, 234);
            Fore = Dark ? Color.FromArgb(240, 240, 240) : Color.FromArgb(26, 26, 26);
            Gray = Dark ? Color.FromArgb(155, 155, 155) : Color.FromArgb(128, 128, 128);
            Sep = Dark ? Color.FromArgb(68, 68, 68) : Color.FromArgb(226, 226, 226);
            Border = Dark ? Color.FromArgb(70, 70, 70) : Color.FromArgb(214, 214, 214);
        }

        /// <summary>行高加大；子菜单同样的底色、圆角</summary>
        public static void Style(ToolStripItemCollection items)
        {
            foreach (ToolStripItem item in items)
            {
                if (item is ToolStripSeparator sep)
                {
                    sep.AutoSize = false;
                    sep.Height = 9;
                    continue;
                }
                item.Padding = new Padding(2, 5, 8, 5);
                if (item is ToolStripMenuItem mi && mi.HasDropDownItems)
                {
                    var drop = mi.DropDown;
                    drop.BackColor = Back;
                    drop.Padding = new Padding(0, 4, 0, 4);
                    if (drop is ToolStripDropDownMenu dm) dm.ShowImageMargin = true;
                    drop.HandleCreated += (s, e) => RoundCorners(drop);
                    Style(mi.DropDownItems);
                }
            }
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        /// <summary>Windows 11 上把菜单窗口设成圆角（DWMWA_WINDOW_CORNER_PREFERENCE = 圆角）；Windows 10 上没有这个属性，调用无效果</summary>
        public static void RoundCorners(Control c)
        {
            try { var round = 2; DwmSetWindowAttribute(c.Handle, 33, ref round, sizeof(int)); } catch { }
        }
    }

    internal sealed class ModernRenderer : ToolStripRenderer
    {
        private static GraphicsPath Rounded(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            var d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            using (var b = new SolidBrush(MenuTheme.Back)) e.Graphics.FillRectangle(b, e.AffectedBounds);
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            var r = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
            using (var p = new Pen(MenuTheme.Border)) e.Graphics.DrawRectangle(p, r);
        }

        // 左边的图标栏和底色一样，不画成灰条
        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            var item = e.Item;
            if (!item.Selected || !item.Enabled || (item.Tag as TwoTone)?.Static == true) return;
            var r = new Rectangle(4, 1, item.Width - 8, item.Height - 2);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var b = new SolidBrush(MenuTheme.Hover))
            using (var path = Rounded(r, 4))
                e.Graphics.FillPath(b, path);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            var y = e.Item.Height / 2;
            using (var p = new Pen(MenuTheme.Sep)) e.Graphics.DrawLine(p, 12, y, e.Item.Width - 12, y);
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            var tt = e.Item.Tag as TwoTone;
            var color = e.Item.Enabled || tt?.Static == true ? MenuTheme.Fore : MenuTheme.Gray;
            const TextFormatFlags flags = TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
            if (tt == null)
            {
                // 带下拉的项右边留出箭头的位置
                TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, color, flags);
                return;
            }
            using (var font = tt.Bold ? new Font(e.TextFont, FontStyle.Bold) : null)
            {
                var mainFont = font ?? e.TextFont;
                var r = e.TextRectangle;
                TextRenderer.DrawText(e.Graphics, tt.Main, mainFont, r, color, flags);
                var w = TextRenderer.MeasureText(e.Graphics, tt.Main, mainFont, r.Size, flags).Width;
                var sub = new Rectangle(r.X + w + 10, r.Y, Math.Max(0, r.Width - w - 10), r.Height);
                TextRenderer.DrawText(e.Graphics, tt.Sub, e.TextFont, sub, MenuTheme.Gray, flags | TextFormatFlags.EndEllipsis);
            }
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = e.Item?.Enabled == false ? MenuTheme.Gray : MenuTheme.Fore;
            base.OnRenderArrow(e);
        }

        // 勾选：在图标位置画一个对勾，不画方框
        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
        {
            var r = e.ImageRectangle;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var p = new Pen(MenuTheme.Fore, 1.6F))
            {
                var x = r.X + r.Width / 2F;
                var y = r.Y + r.Height / 2F;
                e.Graphics.DrawLines(p, new[] { new PointF(x - 5, y), new PointF(x - 1.5F, y + 3.5F), new PointF(x + 5, y - 4) });
            }
        }
    }

    /// <summary>发消息用的小输入框</summary>
    internal sealed class InputForm : Form
    {
        private readonly TextBox box;
        public string Value => box.Text;

        public InputForm(string title, string hint)
        {
            Text = title;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            TopMost = true;
            Font = new Font("Microsoft YaHei UI", 9F);
            ClientSize = new Size(400, 170);
            Controls.Add(new Label { Text = hint, AutoSize = false, Location = new Point(16, 12), Size = new Size(368, 36) });
            box = new TextBox { Multiline = true, Location = new Point(16, 52), Size = new Size(368, 64), ScrollBars = ScrollBars.Vertical };
            Controls.Add(box);
            var ok = new Button { Text = "发送", DialogResult = DialogResult.OK, Location = new Point(228, 128), Size = new Size(76, 28) };
            var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Location = new Point(308, 128), Size = new Size(76, 28) };
            Controls.Add(ok);
            Controls.Add(cancel);
            AcceptButton = ok;
            CancelButton = cancel;
        }
    }

    // ------------------------------------------------------------------ 卸载

    internal static class Uninstaller
    {
        public static int Run(bool quiet)
        {
            var dir = Paths.InstallDir;
            if (!quiet && MessageBox.Show("卸载 ateam？\n\n会删除 ateam 命令、托盘程序、skill 链接和 hook，并停止从托盘启动的各项目服务。各项目里的 .ateam\\ 和 %USERPROFILE%\\.config\\ateam 不会删除。",
                    "卸载 ateam", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return 1;

            // 1. 停掉正在运行的服务：它们占着 node.exe，不停的话安装目录删不干净
            try
            {
                var json = Json.Parse(File.ReadAllText(Paths.Projects, Encoding.UTF8));
                foreach (var p in json.List("projects").Select(x => x.Str("path")).Where(x => x != null))
                {
                    var st = Program.ReadStatus(p, 800);
                    if (st.Running) Http.Call("http://127.0.0.1:" + st.Port + "/api/shutdown", true, null, 3000);
                }
            }
            catch { }

            // 2. skill 链接、hook、开机自启
            Program.RunAteam("setup --remove", 120000);
            // 3. 托盘、卸载入口、开始菜单、PATH
            Installation.StopTray(dir);
            Installation.Unregister();
            Installation.RemoveFromPath(dir);

            // 4. 删安装目录：本程序就在里面，交给一个稍后执行的 cmd
            Thread.Sleep(1500);
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/d /c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + dir + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetTempPath(),
                });
            }
            catch { }
            if (!quiet) MessageBox.Show("ateam 已卸载。各项目里的 .ateam\\ 和 %USERPROFILE%\\.config\\ateam 没有删除。", "ateam", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }
    }
}
