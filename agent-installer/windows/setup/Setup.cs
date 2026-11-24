// ateam 的 Windows 安装程序（一个 exe，里面嵌着 payload.zip：node、app、托盘程序 ateam.exe、启动脚本 ateam.cmd）。
//
//   ateam-<版本>-win-x64.exe           双击安装：小窗口显示「正在安装」，装完打开托盘程序并说明下一步
//   ateam-<版本>-win-x64.exe /update   托盘或 ateam update 一键更新时调用：不显示窗口，装完重新打开托盘程序
//
// 装到 %LOCALAPPDATA%\Programs\ateam，不需要管理员权限：
//   1. 退掉正在运行的托盘程序（ateam 服务不退：它们不占程序文件，升级后由用户重启，和 Mac 一样）；
//   2. 换掉 app\、ateam.exe、ateam.cmd；node 按版本放在 node\<版本>\，同版本已存在就不动
//      （正在运行的 ateam 服务占着它，换不了也不用换）；
//   3. 安装目录加进用户 PATH（ateam 命令）；
//   4. 以当前用户运行 ateam setup --installer：链接 skill、装 hook、设置开机自启；
//   5. 登记卸载入口和开始菜单快捷方式，打开托盘程序。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Ateam
{
    internal static class Setup
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var silent = args.Any(arg => arg.Equals("/update", StringComparison.OrdinalIgnoreCase)
                                      || arg.Equals("/silent", StringComparison.OrdinalIgnoreCase));

            // 一键更新时由 ateam（node）拉起，当前目录可能在安装目录里：进程的当前目录会占着那个文件夹，删不掉
            try { Directory.SetCurrentDirectory(Path.GetTempPath()); } catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (silent)
            {
                try
                {
                    Install();
                    return 0;
                }
                catch (Exception err)
                {
                    MessageBox.Show("ateam 更新失败：" + err.Message + "\n\n可以重新下载安装包，双击安装。",
                        "ateam", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
            }

            var form = new ProgressForm();
            string summary = null;
            form.Shown += async (s, e) =>
            {
                try
                {
                    summary = await Task.Run(Install);
                    form.Close();
                }
                catch (Exception err)
                {
                    form.Hide();
                    MessageBox.Show("ateam 安装失败：" + err.Message, "ateam", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    form.Close();
                }
            };
            Application.Run(form);
            if (summary != null)
            {
                MessageBox.Show(summary, "ateam " + Version + " 已安装", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return 0;
        }

        private static string Version => Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

        private static string Log => Path.Combine(Path.GetTempPath(), "ateam-install.log");

        /// <summary>装好后给用户看的说明（首次安装时弹出）</summary>
        private static string Install()
        {
            var dir = Installation.DefaultDir;
            var root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            File.WriteAllText(Log, "ateam " + Version + " 安装 " + DateTime.Now + "\r\n");

            // 1. 退掉托盘程序，ateam.exe 才换得了
            Installation.StopTray(dir);
            Directory.CreateDirectory(dir);

            // 2. 换掉程序文件
            Installation.DeleteWithRetry(Path.Combine(dir, "app"));
            foreach (var name in new[] { "ateam.exe", "ateam.exe.config", "ateam.cmd" })
            {
                Installation.DeleteFileWithRetry(Path.Combine(dir, name));
            }

            string nodeDir = null;
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (stream == null) throw new InvalidOperationException("安装包损坏：里面没有程序文件");
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    foreach (var entry in zip.Entries)
                    {
                        var target = Path.GetFullPath(Path.Combine(dir, entry.FullName.Replace('/', '\\')));
                        // 防「../」跑出安装目录（安装包是自己打的，多一道防线而已）
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        var parts = entry.FullName.Split('/');
                        if (parts.Length == 3 && parts[0] == "node" && parts[2] == "node.exe") nodeDir = Path.Combine(dir, "node", parts[1]);
                        // 同版本的 node 已经在了：正在运行的 ateam 服务可能占着它，不覆盖
                        if (parts[0] == "node" && File.Exists(target)) continue;
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        entry.ExtractToFile(target, true);
                    }
                }
            }
            var exe = Path.Combine(dir, "ateam.exe");
            if (!File.Exists(exe) || nodeDir == null) throw new InvalidOperationException("安装包损坏：缺少 ateam.exe 或 node");
            var node = Path.Combine(nodeDir, "node.exe");

            // 旧版本的 node：没被占着就删掉
            foreach (var old in Directory.GetDirectories(Path.Combine(dir, "node")))
            {
                if (string.Equals(Path.GetFullPath(old).TrimEnd('\\'), Path.GetFullPath(nodeDir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
                try { Directory.Delete(old, true); } catch { }
            }

            // 3. 用户 PATH
            var pathAdded = Installation.AddToPath(dir);

            // 4. ateam setup：链接 skill、装 hook、开机自启。没做成不影响安装，之后在终端运行 ateam setup 补做
            var setupOut = RunNode(node, Path.Combine(dir, "app", "bin", "ateam.js"), "setup --installer");
            File.AppendAllText(Log, setupOut + "\r\n");

            // 5. 卸载入口、开始菜单，打开托盘
            var firstInstall = !Installation.IsInstalled();
            Installation.Register(dir, Version);
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = dir });

            var text = new StringBuilder();
            text.AppendLine("ateam 托盘程序已在屏幕右下角运行（图标在通知区域，可能收在「^」里）。右键图标添加项目、启动服务、打开看板。");
            text.AppendLine();
            if (pathAdded || firstInstall)
            {
                text.AppendLine("已把 ateam 命令加入 PATH：请重新打开终端、Claude Code、DeepSeek Harness 和 WorkBuddy，之后在里面才能使用 ateam 命令。");
                text.AppendLine();
            }
            var lines = setupOut.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries).Take(14).ToArray();
            if (lines.Length > 0)
            {
                text.AppendLine("skill 和 hook：");
                foreach (var line in lines) text.AppendLine(line);
                text.AppendLine();
            }
            text.Append("安装记录：" + Log);
            return text.ToString();
        }

        /// <summary>用安装好的 node 运行 ateam 子命令，返回输出（UTF-8）</summary>
        private static string RunNode(string node, string script, string args)
        {
            try
            {
                var info = new ProcessStartInfo(node, "\"" + script + "\" " + args)
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
                    if (!p.WaitForExit(120000)) { try { p.Kill(); } catch { } }
                    return (output + err.Result).Trim();
                }
            }
            catch (Exception err)
            {
                return "ateam setup 没有运行成功（" + err.Message + "），之后在终端运行 ateam setup 补做。";
            }
        }
    }

    /// <summary>安装时那个小窗口：一行字 + 一根走马灯进度条</summary>
    internal sealed class ProgressForm : Form
    {
        public ProgressForm()
        {
            Text = "安装 ateam";
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(420, 110);
            Font = new Font("Microsoft YaHei UI", 9F);
            Controls.Add(new Label
            {
                Text = "正在安装 ateam，装好后托盘图标会出现在屏幕右下角……",
                AutoSize = false,
                Location = new Point(24, 24),
                Size = new Size(372, 24),
            });
            Controls.Add(new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 30,
                Location = new Point(24, 60),
                Size = new Size(372, 18),
            });
        }
    }
}
