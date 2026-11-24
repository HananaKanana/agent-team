// 安装程序（setup）和托盘程序 ateam.exe --uninstall 共用的部分：退掉正在运行的托盘程序、
// 用户 PATH、「设置 → 应用」里的卸载入口、开始菜单快捷方式。
//
// 全部装在当前用户名下（HKCU、用户自己的开始菜单），不需要管理员权限。参考 apiloop 的 Windows 安装包。
// 开机自启（HKCU\...\Run 里的 ateam）由 ateam setup 和托盘菜单管理（src/install.js 的 setLoginItem），这里只在卸载时删掉。

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace Ateam
{
    internal static class Installation
    {
        public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string RunValue = "ateam";
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ateam";
        private const string EnvKey = "Environment";

        /// <summary>安装目录：%LOCALAPPDATA%\Programs\ateam（和 src/install.js 的 INSTALL_DIR 一致）</summary>
        public static string DefaultDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "ateam");

        private static string StartMenuLink =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "ateam.lnk");

        /// <summary>退掉安装目录里正在运行的托盘程序（当前进程除外）。ateam 服务（node）不退：它们不占程序文件，升级后由用户重启</summary>
        public static void StopTray(string dir)
        {
            var root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            var self = Process.GetCurrentProcess().Id;
            foreach (var process in Process.GetProcessesByName("ateam"))
            {
                try
                {
                    if (process.Id == self) continue;
                    var file = process.MainModule?.FileName;
                    if (file == null || !file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                    process.Kill();
                    process.WaitForExit(5000);
                }
                catch
                {
                    // 别的用户的进程、刚好退出了：跳过
                }
                finally
                {
                    process.Dispose();
                }
            }
        }

        /// <summary>卸载入口 + 开始菜单快捷方式</summary>
        public static void Register(string dir, string version)
        {
            var exe = Path.Combine(dir, "ateam.exe");
            using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", "ateam");
                key.SetValue("DisplayVersion", version);
                key.SetValue("Publisher", "ateam");
                key.SetValue("DisplayIcon", exe);
                key.SetValue("InstallLocation", dir);
                key.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                key.SetValue("QuietUninstallString", "\"" + exe + "\" --uninstall --quiet");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", (int)(DirectorySize(dir) / 1024), RegistryValueKind.DWord);
            }
            CreateShortcut(StartMenuLink, exe, dir);
        }

        public static void Unregister()
        {
            try
            {
                using (var run = Registry.CurrentUser.OpenSubKey(RunKey, true)) run?.DeleteValue(RunValue, false);
            }
            catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
            try { File.Delete(StartMenuLink); } catch { }
        }

        public static bool IsInstalled()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey)) return key != null;
        }

        // ---------- 用户 PATH：ateam.cmd 在安装目录里，把安装目录加进去，终端和 agent 平台里才能直接运行 ateam ----------

        /// <summary>把 dir 加到用户 PATH 末尾（已有就不动）。返回是否改动了</summary>
        public static bool AddToPath(string dir)
        {
            using (var env = Registry.CurrentUser.CreateSubKey(EnvKey))
            {
                var raw = env.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
                var parts = raw.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries).ToList();
                if (parts.Any(p => SamePath(p, dir))) return false;
                parts.Add(dir);
                // 原来是 REG_EXPAND_SZ（里面有 %USERPROFILE% 之类）就保持
                var kind = raw.Contains("%") ? RegistryValueKind.ExpandString : RegistryValueKind.String;
                env.SetValue("Path", string.Join(";", parts), kind);
            }
            BroadcastEnvironmentChange();
            return true;
        }

        public static void RemoveFromPath(string dir)
        {
            using (var env = Registry.CurrentUser.OpenSubKey(EnvKey, true))
            {
                if (env == null) return;
                var raw = env.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
                var parts = raw.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries).ToList();
                var kept = parts.Where(p => !SamePath(p, dir)).ToList();
                if (kept.Count == parts.Count) return;
                env.SetValue("Path", string.Join(";", kept), raw.Contains("%") ? RegistryValueKind.ExpandString : RegistryValueKind.String);
            }
            BroadcastEnvironmentChange();
        }

        private static bool SamePath(string a, string b)
        {
            try
            {
                var x = Path.GetFullPath(Environment.ExpandEnvironmentVariables(a)).TrimEnd('\\');
                var y = Path.GetFullPath(b).TrimEnd('\\');
                return string.Equals(x, y, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);

        /// <summary>通知资源管理器环境变量变了：之后从开始菜单 / 资源管理器新打开的程序能拿到新 PATH（已经开着的不会）</summary>
        private static void BroadcastEnvironmentChange()
        {
            try { SendMessageTimeout((IntPtr)0xffff, 0x001A, UIntPtr.Zero, "Environment", 0x0002, 3000, out _); } catch { }
        }

        /// <summary>用系统自带的 WScript.Shell 建 .lnk（反射调用，不用额外引用）</summary>
        private static void CreateShortcut(string link, string target, string workingDir)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(link));
                var type = Type.GetTypeFromProgID("WScript.Shell");
                var shell = Activator.CreateInstance(type);
                var shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { link });
                var shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDir });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { target + ",0" });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "ateam 托盘程序" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch
            {
                // 建不了快捷方式不影响使用
            }
        }

        private static long DirectorySize(string dir)
        {
            try
            {
                return new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(file => file.Length);
            }
            catch
            {
                return 0;
            }
        }

        /// <summary>删目录，被占着时重试几次（刚退掉的进程可能还没完全放手）</summary>
        public static void DeleteWithRetry(string path)
        {
            for (var attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    if (Directory.Exists(path)) Directory.Delete(path, true);
                    return;
                }
                catch when (attempt < 9)
                {
                    Thread.Sleep(500);
                }
            }
        }

        public static void DeleteFileWithRetry(string file)
        {
            for (var attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    if (File.Exists(file)) File.Delete(file);
                    return;
                }
                catch when (attempt < 9)
                {
                    Thread.Sleep(500);
                }
            }
        }
    }
}
