// dsh-computer-use automation engine.
//
// All Win32 / GDI / UIA work lives here; the PowerShell shim
// (computer-bridge.ps1) only does NDJSON framing and dictionary conversion.
// Keeping the P/Invoke surface out of the .ps1 avoids Defender AMSI
// false-positives on "malicious content" while compiling the exact same code.
//
// Compiled once per bridge process by the shim (Add-Type -Path Engine.cs).

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using System.Windows.Forms;

namespace DshComputerUse
{
    /// <summary>Op failure with a stable protocol error code.</summary>
    public class BridgeException : Exception
    {
        public readonly string Code;
        public BridgeException(string code, string message) : base(message) { Code = code; }
    }

    public static class Engine
    {
        // ------------------------------------------------------------------
        // Native surface (compiled once, inside this .cs only)
        // ------------------------------------------------------------------

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, INPUT[] inputs, int size);

        [DllImport("user32.dll")]
        private static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT point);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int cmd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("kernel32.dll")]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll")]
        private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll")]
        private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("imm32.dll")]
        private static extern IntPtr ImmAssociateContext(IntPtr hwnd, IntPtr context);

        [DllImport("user32.dll")]
        private static extern IntPtr GetKeyboardLayout(uint idThread);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public long pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        /// <summary>Parent process id for a pid, 0 when unknown.</summary>
        private static uint ParentOf(uint processId)
        {
            var handle = CreateToolhelp32Snapshot(0x2, 0); // TH32CS_SNAPPROCESS
            if (handle == IntPtr.Zero || handle == (IntPtr)(-1)) return 0;
            try
            {
                var entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (Process32First(handle, ref entry))
                {
                    do
                    {
                        if (entry.th32ProcessID == processId) return entry.th32ParentProcessID;
                    } while (Process32Next(handle, ref entry));
                }
            }
            catch { }
            finally { CloseHandle(handle); }
            return 0;
        }

        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT { public uint type; public InputUnion u; }

        private const uint InputMouse = 0;
        private const uint InputKeyboard = 1;
        private const uint KeyUpFlag = 0x0002;
        private const uint KeyUnicode = 0x0004;
        private const uint MouseMoveFlag = 0x0001;
        private const uint MouseLeftDown = 0x0002;
        private const uint MouseLeftUp = 0x0004;
        private const uint MouseRightDown = 0x0008;
        private const uint MouseRightUp = 0x0010;
        private const uint MouseMiddleDown = 0x0020;
        private const uint MouseMiddleUp = 0x0040;
        private const uint MouseWheelFlag = 0x0800;
        private const uint MouseHWheelFlag = 0x1000;
        private const uint MouseAbsolute = 0x8000;
        private const uint MouseVirtualDesk = 0x4000;

        static Engine()
        {
            // Physical pixels for every coordinate this process touches,
            // regardless of the display scale factor (this machine: 150%).
            SetProcessDPIAware();
        }

        private static uint SendOne(INPUT input)
        {
            var array = new[] { input };
            return SendInput(1, array, Marshal.SizeOf(typeof(INPUT)));
        }

        private static uint SendBatch(INPUT[] inputs)
        {
            return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        private static INPUT KeyInput(ushort vk, bool up)
        {
            var input = new INPUT { type = InputKeyboard };
            input.u.ki.vk = vk;
            input.u.ki.flags = up ? KeyUpFlag : 0u;
            return input;
        }

        private static INPUT CharInput(ushort ch, bool up)
        {
            var input = new INPUT { type = InputKeyboard };
            input.u.ki.vk = 0;
            input.u.ki.scan = ch;
            input.u.ki.flags = KeyUnicode | (up ? KeyUpFlag : 0u);
            return input;
        }

        private static uint SendMouse(uint flags, int dx, int dy, uint data)
        {
            var input = new INPUT { type = InputMouse };
            input.u.mi.dx = dx;
            input.u.mi.dy = dy;
            input.u.mi.data = data;
            input.u.mi.flags = flags;
            return SendOne(input);
        }

        // ------------------------------------------------------------------
        // Argument helpers (args arrive as Dictionary<string, object>)
        // ------------------------------------------------------------------

        private static int Int(Dictionary<string, object> a, string key, int fallback)
        {
            object raw;
            if (a == null || !a.TryGetValue(key, out raw) || raw == null) return fallback;
            try { return Convert.ToInt32(raw); } catch { return fallback; }
        }

        private static long Long(Dictionary<string, object> a, string key, long fallback)
        {
            object raw;
            if (a == null || !a.TryGetValue(key, out raw) || raw == null) return fallback;
            try { return Convert.ToInt64(raw); } catch { return fallback; }
        }

        private static string Str(Dictionary<string, object> a, string key, string fallback)
        {
            object raw;
            if (a == null || !a.TryGetValue(key, out raw) || raw == null) return fallback;
            return raw.ToString();
        }

        private static bool Has(Dictionary<string, object> a, string key)
        {
            return a != null && a.ContainsKey(key) && a[key] != null;
        }

        private static Dictionary<string, object> Dict(params object[] pairs)
        {
            var d = new Dictionary<string, object>();
            for (var i = 0; i + 1 < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1];
            return d;
        }

        private static IntPtr HwndOf(Dictionary<string, object> a, string key)
        {
            var handle = Long(a, key, 0);
            var hwnd = (IntPtr)handle;
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                throw new BridgeException("HWND_NOT_FOUND", "window handle " + handle + " is no longer valid");
            return hwnd;
        }

        // ------------------------------------------------------------------
        // Dispatch. Unknown ops raise UNKNOWN_OP; everything else is op code.
        // ------------------------------------------------------------------

        public static object Run(string op, Dictionary<string, object> args)
        {
            switch (op)
            {
                case "ping": return Ping();
                case "screen.list": return ScreenList();
                case "screen.capture": return ScreenCapture(args);
                case "window.list": return WindowList(args);
                case "window.focus": return WindowFocus(args);
                case "window.state": return WindowState(args);
                case "window.launch": return WindowLaunch(args);
                case "mouse.move": return MouseMove(args);
                case "mouse.click": return MouseClick(args);
                case "mouse.drag": return MouseDrag(args);
                case "mouse.scroll": return MouseScroll(args);
                case "keyboard.type": return KeyboardType(args);
                case "keyboard.press": return KeyboardPress(args);
                case "uia.tree": return UiaTree(args);
                case "uia.find": return UiaFind(args);
                case "uia.invoke": return UiaInvoke(args);
                case "clipboard.get": return ClipboardGet();
                case "clipboard.set": return ClipboardSet(args);
                case "overlay.show": return Overlay.Show(args);
                case "overlay.hide": return Overlay.Hide();
                case "overlay.state": return Overlay.State();
                default:
                    throw new BridgeException("UNKNOWN_OP", "unknown op '" + op + "'");
            }
        }

        // ------------------------------------------------------------------
        // ping / screen
        // ------------------------------------------------------------------

        private static int QueryDpi()
        {
            try
            {
                using (var g = Graphics.FromHwnd(IntPtr.Zero)) return (int)Math.Round(g.DpiX);
            }
            catch { return 96; }
        }

        private static object Ping()
        {
            string os;
            try { os = Environment.OSVersion.VersionString; } catch { os = "Windows"; }
            return Dict("version", "1.0.0", "platform", "win32", "os", os, "dpi", QueryDpi());
        }

        private static object ScreenList()
        {
            var monitors = new List<object>();
            var screens = Screen.AllScreens;
            for (var i = 0; i < screens.Length; i++)
            {
                var s = screens[i];
                monitors.Add(Dict(
                    "index", i + 1,
                    "x", s.Bounds.X, "y", s.Bounds.Y,
                    "width", s.Bounds.Width, "height", s.Bounds.Height,
                    "primary", s.Primary,
                    "device", s.DeviceName));
            }
            POINT cursor;
            GetCursorPos(out cursor);
            return Dict(
                "monitors", monitors.ToArray(),
                "cursor", Dict("x", cursor.X, "y", cursor.Y),
                "dpi", QueryDpi());
        }

        // ------------------------------------------------------------------
        // screen.capture
        // ------------------------------------------------------------------

        private static object ScreenCapture(Dictionary<string, object> a)
        {
            var maxEdge = Int(a, "maxEdge", 1280);
            if (maxEdge < 16) maxEdge = 16;
            if (maxEdge > 8000) maxEdge = 8000;
            var format = Str(a, "format", "jpeg") == "png" ? "png" : "jpeg";
            var quality = Int(a, "quality", 72);
            if (quality < 1) quality = 1;
            if (quality > 100) quality = 100;
            var dir = Str(a, "dir", null);
            if (string.IsNullOrEmpty(dir)) dir = Path.Combine(Path.GetTempPath(), "dsh-computer-use");
            Directory.CreateDirectory(dir);

            Bitmap bmp = null;
            Bitmap scaled = null;
            Bitmap shrink = null;
            var originX = 0;
            var originY = 0;
            try
            {
                if (Has(a, "windowHandle"))
                {
                    var hwnd = (IntPtr)Long(a, "windowHandle", 0);
                    if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                        throw new BridgeException("HWND_NOT_FOUND", "window handle " + hwnd.ToInt64() + " is no longer valid");
                    var rect = new RECT();
                    GetWindowRect(hwnd, out rect);
                    if (IsIconic(hwnd))
                    {
                        ShowWindowAsync(hwnd, 9); // SW_RESTORE; PrintWindow of an iconic window is blank
                        System.Threading.Thread.Sleep(400);
                        GetWindowRect(hwnd, out rect);
                    }
                    var w = rect.Right - rect.Left;
                    var h = rect.Bottom - rect.Top;
                    if (w <= 0 || h <= 0) throw new BridgeException("OP_FAILED", "window rect is empty");
                    bmp = new Bitmap(w, h);
                    using (var g = Graphics.FromImage(bmp))
                    {
                        var hdc = g.GetHdc();
                        bool ok;
                        try { ok = PrintWindow(hwnd, hdc, 2); } finally { g.ReleaseHdc(hdc); } // 2 = PW_RENDERFULLCONTENT
                        if (!ok)
                        {
                            SetForegroundWindow(hwnd);
                            System.Threading.Thread.Sleep(250);
                            g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(w, h));
                        }
                    }
                    originX = rect.Left;
                    originY = rect.Top;
                }
                else if (Has(a, "region"))
                {
                    var region = a["region"] as Dictionary<string, object>;
                    if (region == null) throw new BridgeException("INVALID_ARGS", "region must be an object");
                    var x = Int(region, "x", 0);
                    var y = Int(region, "y", 0);
                    var w = Int(region, "width", 0);
                    var h = Int(region, "height", 0);
                    if (w <= 0 || h <= 0) throw new BridgeException("INVALID_ARGS", "region width/height must be positive");
                    bmp = new Bitmap(w, h);
                    using (var g = Graphics.FromImage(bmp))
                        g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
                    originX = x;
                    originY = y;
                }
                else
                {
                    var index = Int(a, "monitor", 1); // 1-based; 1 = primary
                    var screens = Screen.AllScreens;
                    if (index < 1 || index > screens.Length)
                        throw new BridgeException("INVALID_ARGS", "monitor index " + index + " out of range (1.." + screens.Length + ")");
                    var b = screens[index - 1].Bounds;
                    bmp = new Bitmap(b.Width, b.Height);
                    using (var g = Graphics.FromImage(bmp))
                        g.CopyFromScreen(b.X, b.Y, 0, 0, new Size(b.Width, b.Height));
                    originX = b.X;
                    originY = b.Y;
                }

                // Downscale so the long edge fits maxEdge — the token-budget lever.
                var outW = bmp.Width;
                var outH = bmp.Height;
                var longEdge = Math.Max(outW, outH);
                if (longEdge > maxEdge)
                {
                    var ratio = (double)maxEdge / longEdge;
                    outW = Math.Max(1, (int)Math.Floor(bmp.Width * ratio));
                    outH = Math.Max(1, (int)Math.Floor(bmp.Height * ratio));
                    scaled = new Bitmap(bmp, outW, outH);
                }
                else
                {
                    scaled = bmp;
                }

                // Budget convergence. One capture must never cost an unbounded
                // number of image tokens, so encode, then trade quality (JPEG
                // only) and finally edges until the base64 payload fits. The
                // reported quality/size are the ones actually written.
                var budgetB64 = (long)Math.Max(0, Int(a, "budgetKb", 0)) * 1024;
                var budgetPixels = Math.Max(0L, Long(a, "budgetPixels", 0));
                ImageCodecInfo codec = null;
                if (format == "png")
                {
                    codec = null;
                }
                else
                {
                    foreach (var enc in ImageCodecInfo.GetImageEncoders())
                        if (enc.MimeType == "image/jpeg") { codec = enc; break; }
                }

                var qualityNow = quality;
                var source = scaled;
                var data = format == "png" ? EncodePng(source) : EncodeJpeg(source, codec, qualityNow);
                while (budgetB64 > 0 && format != "png" && qualityNow > MinQuality && Base64Length(data.Length) > budgetB64)
                {
                    qualityNow = Math.Max(MinQuality, qualityNow - QualityStep);
                    data = EncodeJpeg(source, codec, qualityNow);
                }
                // Fit the pixel budget in one step, so a capture lands as close to
                // the allowed size as possible; the 0.8 walk below then only pays
                // for the base64 budget instead of overshooting both.
                if (budgetPixels > 0 && (long)outW * outH > budgetPixels)
                {
                    var fit = Math.Sqrt((double)budgetPixels / ((double)outW * outH));
                    var fitW = Math.Max(1, (int)Math.Floor(outW * fit));
                    var fitH = Math.Max(1, (int)Math.Floor(outH * fit));
                    var fitted = new Bitmap(source, fitW, fitH);
                    if (shrink != null) shrink.Dispose();
                    shrink = fitted;
                    source = fitted;
                    outW = fitW;
                    outH = fitH;
                    data = format == "png" ? EncodePng(source) : EncodeJpeg(source, codec, qualityNow);
                }

                while (Math.Max(outW, outH) > MinEdge &&
                       ((budgetB64 > 0 && Base64Length(data.Length) > budgetB64) ||
                        (budgetPixels > 0 && (long)outW * outH > budgetPixels)))
                {
                    var nextW = Math.Max(1, (int)Math.Floor(outW * ShrinkFactor));
                    var nextH = Math.Max(1, (int)Math.Floor(outH * ShrinkFactor));
                    var smaller = new Bitmap(source, nextW, nextH);
                    if (shrink != null) shrink.Dispose();
                    shrink = smaller;
                    source = smaller;
                    outW = nextW;
                    outH = nextH;
                    data = format == "png" ? EncodePng(source) : EncodeJpeg(source, codec, qualityNow);
                }

                _captureSeq++;
                var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
                var path = Path.Combine(dir, "capture-" + stamp + "-" + _captureSeq + (format == "png" ? ".png" : ".jpg"));
                File.WriteAllBytes(path, data);

                return Dict(
                    "path", path,
                    "width", outW, "height", outH,
                    "format", format, "bytes", data.Length,
                    "quality", format == "png" ? 100 : qualityNow,
                    "base64Bytes", Base64Length(data.Length),
                    "originX", originX, "originY", originY);
            }
            finally
            {
                if (shrink != null && !ReferenceEquals(shrink, scaled) && !ReferenceEquals(shrink, bmp)) shrink.Dispose();
                if (scaled != null && !ReferenceEquals(scaled, bmp)) scaled.Dispose();
                if (bmp != null) bmp.Dispose();
            }
        }

        // Screenshot budget knobs (mirrors the ZCode capture pipeline documented
        // in docs/research-computer-use.md §4.2): quality first, then edges.
        private const int MinQuality = 40;
        private const int QualityStep = 15;
        private const double ShrinkFactor = 0.8;
        private const int MinEdge = 320;

        private static byte[] EncodeJpeg(Bitmap img, ImageCodecInfo codec, int quality)
        {
            if (codec == null) throw new BridgeException("OP_FAILED", "no JPEG encoder is available");
            using (var p = new EncoderParameters(1))
            {
                p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                using (var ms = new MemoryStream())
                {
                    img.Save(ms, codec, p);
                    return ms.ToArray();
                }
            }
        }

        private static byte[] EncodePng(Bitmap img)
        {
            using (var ms = new MemoryStream())
            {
                img.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }

        /// <summary>Base64 payload length of a byte count — the number the model's image budget sees.</summary>
        private static long Base64Length(long bytes)
        {
            return ((bytes + 2) / 3) * 4;
        }

        // ------------------------------------------------------------------
        // windows
        // ------------------------------------------------------------------

        private static readonly List<long> RefsUnderSweep = new List<long>();
        private static readonly Dictionary<long, AutomationElement> UiaElements = new Dictionary<long, AutomationElement>();
        private static readonly Dictionary<string, List<long>> UiaByWindow = new Dictionary<string, List<long>>();
        private static long _nextRef = 1;
        private static int _captureSeq;

        private static object WindowList(Dictionary<string, object> a)
        {
            var limit = Int(a, "limit", 40);
            if (limit < 1) limit = 1;
            if (limit > 200) limit = 200;
            var rows = new List<object>();
            var foreground = GetForegroundWindow();
            EnumWindows(delegate(IntPtr hWnd, IntPtr lp)
            {
                try
                {
                    if (!IsWindowVisible(hWnd)) return true;
                    var title = new StringBuilder(512);
                    GetWindowText(hWnd, title, 512);
                    if (title.Length == 0) return true;
                    var cls = new StringBuilder(256);
                    GetClassName(hWnd, cls, 256);
                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    var rect = new RECT();
                    GetWindowRect(hWnd, out rect);
                    rows.Add(Dict(
                        "handle", hWnd.ToInt64(),
                        "pid", (int)pid,
                        "title", title.ToString(),
                        "className", cls.ToString(),
                        "x", rect.Left, "y", rect.Top,
                        "width", rect.Right - rect.Left, "height", rect.Bottom - rect.Top,
                        "minimized", IsIconic(hWnd),
                        "foreground", hWnd == foreground));
                }
                catch { }
                return true;
            }, IntPtr.Zero);

            // Foreground first, then by area, so relevant windows lead the list.
            rows.Sort(delegate(object l, object r)
            {
                var x = (Dictionary<string, object>)l;
                var y = (Dictionary<string, object>)r;
                var fx = (bool)x["foreground"] ? 0 : 1;
                var fy = (bool)y["foreground"] ? 0 : 1;
                if (fx != fy) return fx.CompareTo(fy);
                var ax = (int)x["width"] * (int)x["height"];
                var ay = (int)y["width"] * (int)y["height"];
                return ay.CompareTo(ax);
            });
            if (rows.Count > limit) rows.RemoveRange(limit, rows.Count - limit);

            // window.list doubles as the UIA registry sweep point.
            ClearStaleUiaRefs();
            return Dict("windows", rows.ToArray());
        }

        private static object WindowFocus(Dictionary<string, object> a)
        {
            var hwnd = HwndOf(a, "handle");
            if (IsIconic(hwnd))
            {
                ShowWindowAsync(hwnd, 9); // SW_RESTORE
                System.Threading.Thread.Sleep(250);
            }
            // AttachThreadInput makes SetForegroundWindow reliable from a
            // background process: briefly share the input queue.
            var fg = GetForegroundWindow();
            var me = GetCurrentThreadId();
            uint targetPid;
            var targetThread = GetWindowThreadProcessId(hwnd, out targetPid);
            uint fgPid;
            var fgThread = GetWindowThreadProcessId(fg, out fgPid);
            try
            {
                if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, true);
                if (targetThread != 0 && targetThread != me) AttachThreadInput(me, targetThread, true);
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
            }
            catch { }
            finally
            {
                if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, false);
                if (targetThread != 0 && targetThread != me) AttachThreadInput(me, targetThread, false);
            }
            System.Threading.Thread.Sleep(120);
            var title = new StringBuilder(512);
            GetWindowText(hwnd, title, 512);
            return Dict("handle", hwnd.ToInt64(), "title", title.ToString());
        }

        private static object WindowState(Dictionary<string, object> a)
        {
            var hwnd = HwndOf(a, "handle");
            var state = Str(a, "state", null);
            if (state == "close")
            {
                // Ask the window to close itself, exactly like clicking its X;
                // the bridge never terminates processes.
                PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
            }
            else if (state == "minimize") ShowWindowAsync(hwnd, 6);
            else if (state == "maximize") ShowWindowAsync(hwnd, 3);
            else if (state == "restore") ShowWindowAsync(hwnd, 9);
            else throw new BridgeException("INVALID_ARGS", "unknown state '" + state + "' (minimize|maximize|restore|close)");
            System.Threading.Thread.Sleep(120);
            return Dict("handle", hwnd.ToInt64(), "state", state);
        }

        private static string QuoteWinArg(string value)
        {
            if (System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-zA-Z0-9_\\-./:=,]+$")) return value;
            var escaped = System.Text.RegularExpressions.Regex.Replace(value, "(\\\\+)\"", "$1$1\\\"");
            escaped = System.Text.RegularExpressions.Regex.Replace(escaped, "(\\\\+)$", "$1$1");
            return "\"" + escaped + "\"";
        }

        private static object WindowLaunch(Dictionary<string, object> a)
        {
            var command = Str(a, "command", null);
            if (string.IsNullOrWhiteSpace(command)) throw new BridgeException("INVALID_ARGS", "command is required");
            var argList = new List<string>();
            if (Has(a, "args"))
            {
                var raw = a["args"] as IEnumerable<object>;
                if (raw != null) foreach (var item in raw) argList.Add(item == null ? string.Empty : QuoteWinArg(item.ToString()));
            }
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = command,
                Arguments = string.Join(" ", argList.ToArray()),
                UseShellExecute = true,
            };
            var cwd = Str(a, "cwd", null);
            if (!string.IsNullOrEmpty(cwd)) psi.WorkingDirectory = cwd;

            // Snapshot of visible titled windows before the launch, so a new
            // window can be recognised even when the started process is only
            // an execution-alias stub for the real app.
            var before = new HashSet<long>();
            EnumWindows(delegate(IntPtr hWnd, IntPtr lp)
            {
                try
                {
                    if (IsWindowVisible(hWnd))
                    {
                        var t = new StringBuilder(256);
                        GetWindowText(hWnd, t, 256);
                        if (t.Length > 0) before.Add(hWnd.ToInt64());
                    }
                }
                catch { }
                return true;
            }, IntPtr.Zero);

            var proc = System.Diagnostics.Process.Start(psi);
            var pid = proc != null ? proc.Id : 0;
            var handle = 0L;
            var title = string.Empty;
            // Mirror image name up front: the stub can exit before we probe.
            // The command file name is the fallback (e.g. notepad.exe alias).
            var imageName = Path.GetFileNameWithoutExtension(command);
            try { if (proc != null && !proc.HasExited) imageName = proc.ProcessName; } catch { }
            var launchedPid = (uint)Math.Max(0, pid);
            var started = DateTime.UtcNow;
            while (proc != null && DateTime.UtcNow - started < TimeSpan.FromSeconds(8))
            {
                try
                {
                    proc.Refresh();
                    if (!proc.HasExited && proc.MainWindowHandle != IntPtr.Zero)
                    {
                        handle = proc.MainWindowHandle.ToInt64();
                        title = proc.MainWindowTitle ?? string.Empty;
                        break;
                    }
                }
                catch { }
                // Alias stubs and console hosts stand between the started
                // process and the window: accept a fresh window whose owner
                // is the same image, the started pid itself, or a child host
                // parented by the started pid.
                var found = 0L;
                var foundTitle = string.Empty;
                EnumWindows(delegate(IntPtr hWnd, IntPtr lp)
                {
                    try
                    {
                        if (found != 0 || !IsWindowVisible(hWnd) || before.Contains(hWnd.ToInt64())) return true;
                        var t = new StringBuilder(256);
                        GetWindowText(hWnd, t, 256);
                        if (t.Length == 0) return true;
                        uint ownerPid;
                        GetWindowThreadProcessId(hWnd, out ownerPid);
                        if (ownerPid != 0 && ownerPid != launchedPid)
                        {
                            var matches = false;
                            try
                            {
                                var owner = System.Diagnostics.Process.GetProcessById((int)ownerPid);
                                if (string.Equals(owner.ProcessName, imageName, StringComparison.OrdinalIgnoreCase)) matches = true;
                            }
                            catch { }
                            if (!matches && launchedPid != 0 && ParentOf(ownerPid) == launchedPid) matches = true;
                            if (!matches) return true;
                        }
                        found = hWnd.ToInt64();
                        foundTitle = t.ToString();
                    }
                    catch { }
                    return true;
                }, IntPtr.Zero);
                if (found != 0)
                {
                    handle = found;
                    title = foundTitle;
                    break;
                }
                System.Threading.Thread.Sleep(150);
            }
            return Dict("pid", pid, "handle", handle, "title", title);
        }

        // ------------------------------------------------------------------
        // pointer + text entry
        // ------------------------------------------------------------------

        private static void MoveTo(int x, int y)
        {
            var vx = GetSystemMetrics(76);
            var vy = GetSystemMetrics(77);
            var vw = GetSystemMetrics(78);
            var vh = GetSystemMetrics(79);
            if (vw <= 1) vw = 2;
            if (vh <= 1) vh = 2;
            var ax = (int)((x - vx) * 65535.0 / (vw - 1));
            var ay = (int)((y - vy) * 65535.0 / (vh - 1));
            if (ax < 0) ax = 0; if (ax > 65535) ax = 65535;
            if (ay < 0) ay = 0; if (ay > 65535) ay = 65535;
            SendMouse(MouseMoveFlag | MouseAbsolute | MouseVirtualDesk, ax, ay, 0);
            System.Threading.Thread.Sleep(30);
        }

        private static object MouseMove(Dictionary<string, object> a)
        {
            var x = Int(a, "x", 0);
            var y = Int(a, "y", 0);
            MoveTo(x, y);
            return Dict("x", x, "y", y);
        }

        private static void ClickButton(string button)
        {
            uint down, up;
            if (button == "right") { down = MouseRightDown; up = MouseRightUp; }
            else if (button == "middle") { down = MouseMiddleDown; up = MouseMiddleUp; }
            else { down = MouseLeftDown; up = MouseLeftUp; }
            SendMouse(down, 0, 0, 0);
            System.Threading.Thread.Sleep(40);
            SendMouse(up, 0, 0, 0);
        }

        private static object MouseClick(Dictionary<string, object> a)
        {
            if (Has(a, "x") && Has(a, "y")) MoveTo(Int(a, "x", 0), Int(a, "y", 0));
            var button = Str(a, "button", "left");
            var count = Int(a, "count", 1);
            if (count < 1) count = 1;
            if (count > 5) count = 5;
            for (var i = 0; i < count; i++)
            {
                ClickButton(button);
                if (i < count - 1) System.Threading.Thread.Sleep(90); // stay inside double-click time
            }
            System.Threading.Thread.Sleep(120);
            POINT p;
            GetCursorPos(out p);
            return Dict("x", p.X, "y", p.Y, "button", button, "count", count);
        }

        private static object MouseDrag(Dictionary<string, object> a)
        {
            var fromX = Int(a, "fromX", 0);
            var fromY = Int(a, "fromY", 0);
            var toX = Int(a, "toX", 0);
            var toY = Int(a, "toY", 0);
            var button = Str(a, "button", "left");
            var duration = Int(a, "durationMs", 350);
            if (duration < 50) duration = 50;
            if (duration > 5000) duration = 5000;
            uint down, up;
            if (button == "right") { down = MouseRightDown; up = MouseRightUp; }
            else if (button == "middle") { down = MouseMiddleDown; up = MouseMiddleUp; }
            else { down = MouseLeftDown; up = MouseLeftUp; }
            MoveTo(fromX, fromY);
            System.Threading.Thread.Sleep(120);
            SendMouse(down, 0, 0, 0);
            System.Threading.Thread.Sleep(80);
            var steps = Math.Max(4, Math.Min(60, duration / 12));
            for (var i = 1; i <= steps; i++)
            {
                var t = (double)i / steps;
                MoveTo((int)(fromX + (toX - fromX) * t), (int)(fromY + (toY - fromY) * t));
                System.Threading.Thread.Sleep(Math.Max(1, duration / steps));
            }
            SendMouse(up, 0, 0, 0);
            System.Threading.Thread.Sleep(120);
            return Dict("fromX", fromX, "fromY", fromY, "toX", toX, "toY", toY);
        }

        private static object MouseScroll(Dictionary<string, object> a)
        {
            if (Has(a, "x") && Has(a, "y")) MoveTo(Int(a, "x", 0), Int(a, "y", 0));
            var dx = Int(a, "deltaX", 0);
            var dy = Int(a, "deltaY", 0);
            // Values are wheel notches; 120 units = one notch, positive = up/right.
            if (dy != 0) SendMouse(MouseWheelFlag, 0, 0, unchecked((uint)Math.Round(dy * 120.0)));
            if (dx != 0) SendMouse(MouseHWheelFlag, 0, 0, unchecked((uint)Math.Round(dx * 120.0)));
            System.Threading.Thread.Sleep(80);
            POINT p;
            GetCursorPos(out p);
            return Dict("x", p.X, "y", p.Y);
        }

        private static ushort KeyFor(string name)
        {
            var key = (name ?? string.Empty).Trim().ToLowerInvariant();
            switch (key)
            {
                case "ctrl": case "control": return 0x11;
                case "shift": return 0x10;
                case "alt": case "menu": return 0x12;
                case "win": case "meta": case "lwin": return 0x5B;
                case "rwin": return 0x5C;
                case "enter": case "return": return 0x0D;
                case "esc": case "escape": return 0x1B;
                case "tab": return 0x09;
                case "space": return 0x20;
                case "backspace": return 0x08;
                case "delete": case "del": return 0x2E;
                case "insert": case "ins": return 0x2D;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": return 0x21;
                case "pagedown": return 0x22;
                case "up": return 0x26;
                case "down": return 0x28;
                case "left": return 0x25;
                case "right": return 0x27;
                case "capslock": return 0x14;
                case "numlock": return 0x90;
                case "scrolllock": return 0x91;
                case "pause": return 0x13;
                case "printscreen": return 0x2C;
                case "apps": return 0x5D;
            }
            if (key.Length >= 2 && key[0] == 'f')
            {
                short n;
                if (short.TryParse(key.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
            }
            if (key.Length == 1)
            {
                var c = char.ToUpperInvariant(key[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (ushort)c;
                switch (key)
                {
                    case ".": return 0xBE;
                    case ",": return 0xBC;
                    case "-": return 0xBD;
                    case "=": return 0xBB;
                    case "/": return 0xBF;
                    case "\\": return 0xDC;
                    case ";": return 0xBA;
                    case "'": return 0xDE;
                    case "[": return 0xDB;
                    case "]": return 0xDD;
                    case "`": return 0xC0;
                }
            }
            throw new BridgeException("INVALID_ARGS", "unknown key name '" + name + "' (ctrl/shift/alt/win/enter/esc/tab/space/backspace/delete/home/end/pageup/pagedown/up/down/left/right/f1-f24/a-z/0-9)");
        }

        private static object KeyboardType(Dictionary<string, object> a)
        {
            if (!Has(a, "text")) throw new BridgeException("INVALID_ARGS", "text is required");
            var text = Str(a, "text", string.Empty);
            if (text.Length > 20000) throw new BridgeException("INVALID_ARGS", "text too long (max 20000 chars per call)");

            var hasNonAscii = false;
            foreach (var ch in text) if (ch > 127) { hasNonAscii = true; break; }

            if (!hasNonAscii)
            {
                SendTextKeys(text, Int(a, "intervalMs", 0));
                return Dict("chars", text.Length, "method", "keys");
            }

            // Non-ASCII: the focused window's IME (TSF, e.g. WinUI3 apps) treats
            // unicode events as composition keys and turns them into candidate
            // digits — locale switching and ImmAssociateContext both fail to
            // reach it. Paste instead; the caller's clipboard text is saved and
            // restored so nothing is polluted.
            var saved = string.Empty;
            var hadText = false;
            try { hadText = Clipboard.ContainsText(); if (hadText) saved = Clipboard.GetText(); } catch { }
            try
            {
                Clipboard.SetText(text);
                SendBatch(new[] { KeyInput(0x11, false), KeyInput(0x56, false), KeyInput(0x56, true), KeyInput(0x11, true) });
                System.Threading.Thread.Sleep(200);
            }
            finally
            {
                try
                {
                    if (hadText) Clipboard.SetText(saved); else Clipboard.Clear();
                }
                catch { }
            }
            return Dict("chars", text.Length, "method", "paste");
        }

        private static void SendTextKeys(string text, int interval)
        {
            // CJK events get hijacked by the focused window's IME: TSF-based
            // input (WinUI3) treats them as composition keys that turn into
            // candidate digits. Locale switching and ImmAssociateContext do not
            // reach TSF, so callers get the paste path above for non-ASCII.
            foreach (var ch in text)
            {
                if (ch == '\r') continue; // CRLF: the LF branch below already lands Enter
                // One atomic batch per character: a split down/up pair lets
                // the next char's events interleave in WinUI3/TSF pipelines
                // (observed as duplicated digits on this machine).
                if (ch == '\n')
                {
                    SendBatch(new[] { KeyInput(0x0D, false), KeyInput(0x0D, true) });
                }
                else
                {
                    SendBatch(new[] { CharInput((ushort)ch, false), CharInput((ushort)ch, true) });
                }
                if (interval > 0) System.Threading.Thread.Sleep(interval);
            }
        }

        private static object KeyboardPress(Dictionary<string, object> a)
        {
            var keys = new List<string>();
            if (Has(a, "keys"))
            {
                var raw = a["keys"] as IEnumerable<object>;
                if (raw != null) foreach (var item in raw) keys.Add(item == null ? string.Empty : item.ToString());
            }
            if (keys.Count == 0) throw new BridgeException("INVALID_ARGS", "keys is required, e.g. [\"ctrl\",\"s\"]");
            var action = Str(a, "action", "press");
            var vks = new ushort[keys.Count];
            for (var i = 0; i < keys.Count; i++) vks[i] = KeyFor(keys[i]);
            if (action == "down")
            {
                var batch = new INPUT[vks.Length];
                for (var i = 0; i < vks.Length; i++) batch[i] = KeyInput(vks[i], false);
                SendBatch(batch);
            }
            else if (action == "up")
            {
                var batch = new INPUT[vks.Length];
                for (var i = 0; i < vks.Length; i++) batch[vks.Length - 1 - i] = KeyInput(vks[i], true);
                SendBatch(batch);
            }
            else
            {
                // One atomic batch: modifiers down, then release in reverse so
                // they lift after the main key.
                var batch = new INPUT[vks.Length * 2];
                for (var i = 0; i < vks.Length; i++) batch[i] = KeyInput(vks[i], false);
                for (var i = 0; i < vks.Length; i++) batch[2 * vks.Length - 1 - i] = KeyInput(vks[i], true);
                SendBatch(batch);
            }
            System.Threading.Thread.Sleep(60);
            return Dict("keys", keys.ToArray());
        }

        // ------------------------------------------------------------------
        // UI Automation
        // ------------------------------------------------------------------

        private static AutomationElement RootElementFor(long? handle)
        {
            var root = AutomationElement.RootElement;
            if (!handle.HasValue || handle.Value == 0) return root;
            // The NativeWindowHandle property condition must box an Int32.
            var cond = new PropertyCondition(AutomationElement.NativeWindowHandleProperty, (int)handle.Value);
            var el = root.FindFirst(TreeScope.Children, cond);
            if (el == null)
                throw new BridgeException("HWND_NOT_FOUND", "no UIA element for handle " + handle.Value);
            return el;
        }

        private static long RegisterElement(AutomationElement el, long? hwnd)
        {
            var reference = _nextRef++;
            UiaElements[reference] = el;
            if (hwnd.HasValue && hwnd.Value != 0)
            {
                var key = hwnd.Value.ToString();
                List<long> list;
                if (!UiaByWindow.TryGetValue(key, out list))
                {
                    list = new List<long>();
                    UiaByWindow[key] = list;
                }
                list.Add(reference);
            }
            // Hard cap: a runaway registry is worse than a stale ref.
            if (UiaElements.Count > 800)
            {
                UiaElements.Clear();
                UiaByWindow.Clear();
            }
            return reference;
        }

        private static void ClearStaleUiaRefs()
        {
            var dead = new List<string>();
            foreach (var key in new List<string>(UiaByWindow.Keys))
            {
                IntPtr hwnd;
                try { hwnd = (IntPtr)Convert.ToInt64(key); }
                catch { dead.Add(key); continue; }
                if (!IsWindow(hwnd)) dead.Add(key);
            }
            foreach (var key in dead)
            {
                foreach (var reference in UiaByWindow[key]) UiaElements.Remove(reference);
                UiaByWindow.Remove(key);
            }
        }

        private static object UiaNode(AutomationElement el, int depth, long? hwnd)
        {
            var c = el.Current;
            var patterns = new List<string>();
            foreach (var p in el.GetSupportedPatterns())
                patterns.Add(p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", string.Empty));

            var rect = c.BoundingRectangle;
            var rx = 0; var ry = 0; var rw = 0; var rh = 0;
            if (!rect.IsEmpty)
            {
                rx = (int)rect.X; ry = (int)rect.Y;
                rw = Math.Max(0, (int)rect.Width); rh = Math.Max(0, (int)rect.Height);
            }
            var name = c.Name;
            if (name != null && name.Length > 120) name = name.Substring(0, 117) + "...";
            var autoId = c.AutomationId;
            if (autoId != null && autoId.Length > 120) autoId = autoId.Substring(0, 117) + "...";
            var role = "Unknown";
            try { role = c.ControlType.ProgrammaticName.Replace("ControlType.", string.Empty); } catch { }

            return Dict(
                "ref", RegisterElement(el, hwnd),
                "depth", depth,
                "role", role,
                "name", name,
                "automationId", autoId,
                "rect", Dict("x", rx, "y", ry, "width", rw, "height", rh),
                "patterns", patterns.ToArray());
        }

        private static object UiaTree(Dictionary<string, object> a)
        {
            long? handle = null;
            if (Has(a, "handle")) handle = Long(a, "handle", 0);
            var maxDepth = Int(a, "maxDepth", 6);
            if (maxDepth < 1) maxDepth = 1;
            if (maxDepth > 12) maxDepth = 12;
            var maxNodes = Int(a, "maxNodes", 150);
            if (maxNodes < 1) maxNodes = 1;
            if (maxNodes > 400) maxNodes = 400;

            var root = RootElementFor(handle);
            var nodes = new List<object> { UiaNode(root, 0, handle) };
            var truncated = false;

            // Explicit stack; reversed pushes keep document order in the output.
            var stack = new Stack<KeyValuePair<AutomationElement, int>>();
            stack.Push(new KeyValuePair<AutomationElement, int>(root, 0));
            while (stack.Count > 0)
            {
                if (nodes.Count >= maxNodes) { truncated = true; break; }
                var frame = stack.Pop();
                if (frame.Value >= maxDepth) continue;
                AutomationElementCollection children;
                try
                {
                    children = frame.Key.FindAll(TreeScope.Children, Condition.TrueCondition);
                }
                catch { continue; }
                var ordered = new List<AutomationElement>();
                foreach (AutomationElement child in children) ordered.Add(child);
                ordered.Reverse();
                foreach (var child in ordered)
                {
                    if (nodes.Count >= maxNodes) { truncated = true; break; }
                    try
                    {
                        nodes.Add(UiaNode(child, frame.Value + 1, handle));
                        stack.Push(new KeyValuePair<AutomationElement, int>(child, frame.Value + 1));
                    }
                    catch { } // element vanished mid-walk
                }
            }
            return Dict("nodes", nodes.ToArray(), "truncated", truncated);
        }

        private static object UiaFind(Dictionary<string, object> a)
        {
            long? handle = null;
            if (Has(a, "handle")) handle = Long(a, "handle", 0);
            var name = Str(a, "name", null);
            var automationId = Str(a, "automationId", null);
            var controlType = Str(a, "controlType", null);
            var limit = Int(a, "limit", 50);
            if (limit < 1) limit = 1;
            if (limit > 200) limit = 200;

            if (string.IsNullOrEmpty(name) && string.IsNullOrEmpty(automationId) && string.IsNullOrEmpty(controlType))
                throw new BridgeException("INVALID_ARGS", "find requires at least one of name / automationId / controlType");

            var root = RootElementFor(handle);
            var condition = Condition.TrueCondition;
            if (!string.IsNullOrEmpty(controlType))
            {
                var field = typeof(ControlType).GetField(controlType);
                if (field == null)
                    throw new BridgeException("INVALID_ARGS", "unknown controlType '" + controlType + "' (e.g. Button, Edit, MenuItem)");
                condition = new PropertyCondition(AutomationElement.ControlTypeProperty, (ControlType)field.GetValue(null));
            }

            var hits = new List<object>();
            AutomationElementCollection found;
            try { found = root.FindAll(TreeScope.Descendants, condition); }
            catch (Exception ex) { throw new BridgeException("OP_FAILED", "uia find failed: " + ex.Message); }
            foreach (AutomationElement el in found)
            {
                if (hits.Count >= limit) break;
                try
                {
                    var c = el.Current;
                    if (!string.IsNullOrEmpty(name))
                    {
                        var elName = c.Name ?? string.Empty;
                        if (elName.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    }
                    if (!string.IsNullOrEmpty(automationId))
                    {
                        var elId = c.AutomationId ?? string.Empty;
                        if (string.Compare(elId, automationId, StringComparison.OrdinalIgnoreCase) != 0) continue;
                    }
                    hits.Add(UiaNode(el, -1, handle));
                }
                catch { }
            }
            return Dict("matches", hits.ToArray(), "count", hits.Count);
        }

        private static KeyValuePair<AutomationElement, long> ResolveUiaTarget(Dictionary<string, object> a)
        {
            // Priority: ref registry > handle + automationId/name search.
            if (Has(a, "ref"))
            {
                var reference = Long(a, "ref", 0);
                AutomationElement el;
                if (!UiaElements.TryGetValue(reference, out el))
                    throw new BridgeException("STALE_REF", "ref " + reference + " is not registered; run uia.tree or uia.find again");
                try { var probe = el.Current.AutomationId; }
                catch
                {
                    UiaElements.Remove(reference);
                    throw new BridgeException("STALE_REF", "ref " + reference + " points at an element that is gone; re-run uia.tree / uia.find");
                }
                return new KeyValuePair<AutomationElement, long>(el, reference);
            }

            long? handle = null;
            if (Has(a, "handle")) handle = Long(a, "handle", 0);
            var name = Str(a, "name", null);
            var automationId = Str(a, "automationId", null);
            if (string.IsNullOrEmpty(name) && string.IsNullOrEmpty(automationId))
                throw new BridgeException("INVALID_ARGS", "invoke requires ref, or automationId, or name");

            var findArgs = new Dictionary<string, object>();
            if (handle.HasValue) findArgs["handle"] = handle.Value;
            if (!string.IsNullOrEmpty(name)) findArgs["name"] = name;
            if (!string.IsNullOrEmpty(automationId)) findArgs["automationId"] = automationId;
            findArgs["limit"] = 1;
            var found = (Dictionary<string, object>)UiaFind(findArgs);
            var matches = (object[])found["matches"];
            if (matches.Length == 0)
                throw new BridgeException("NOT_FOUND", "no control matched (name='" + name + "', automationId='" + automationId + "')");
            var match = (Dictionary<string, object>)matches[0];
            var reference2 = Convert.ToInt64(match["ref"]);
            return new KeyValuePair<AutomationElement, long>(UiaElements[reference2], reference2);
        }

        private static object UiaInvoke(Dictionary<string, object> a)
        {
            var action = Str(a, "action", null);
            if (string.IsNullOrEmpty(action)) throw new BridgeException("INVALID_ARGS", "action is required");
            var target = ResolveUiaTarget(a);
            var el = target.Key;
            var reference = target.Value;

            // Pattern-missing is an action-level failure (ok:false), not an op
            // failure: the model sees the reason and can pick another action.
            object pattern;
            switch (action)
            {
                case "invoke":
                    if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                    {
                        ((InvokePattern)pattern).Invoke();
                        return Dict("ref", reference, "action", action, "ok", true);
                    }
                    // Toggle/Select are common stand-ins for "press this".
                    if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                    {
                        ((TogglePattern)pattern).Toggle();
                        return Dict("ref", reference, "action", "toggle", "ok", true);
                    }
                    if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                    {
                        ((SelectionItemPattern)pattern).Select();
                        return Dict("ref", reference, "action", "select", "ok", true);
                    }
                    return Dict("ref", reference, "action", action, "ok", false,
                        "message", "element does not support Invoke");
                case "select":
                    if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                    {
                        ((SelectionItemPattern)pattern).Select();
                        return Dict("ref", reference, "action", action, "ok", true);
                    }
                    return Dict("ref", reference, "action", action, "ok", false, "message", "element does not support SelectionItem");
                case "toggle":
                    if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                    {
                        ((TogglePattern)pattern).Toggle();
                        return Dict("ref", reference, "action", action, "ok", true);
                    }
                    return Dict("ref", reference, "action", action, "ok", false, "message", "element does not support Toggle");
                case "expand":
                    if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
                    {
                        ((ExpandCollapsePattern)pattern).Expand();
                        return Dict("ref", reference, "action", action, "ok", true);
                    }
                    return Dict("ref", reference, "action", action, "ok", false, "message", "element does not support ExpandCollapse");
                case "collapse":
                    if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
                    {
                        ((ExpandCollapsePattern)pattern).Collapse();
                        return Dict("ref", reference, "action", action, "ok", true);
                    }
                    return Dict("ref", reference, "action", action, "ok", false, "message", "element does not support ExpandCollapse");
                case "setValue":
                    var value = Str(a, "value", string.Empty);
                    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                    {
                        ((ValuePattern)pattern).SetValue(value);
                        return Dict("ref", reference, "action", action, "ok", true);
                    }
                    return Dict("ref", reference, "action", action, "ok", false, "message", "element does not support Value");
                case "getValue":
                    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                    {
                        return Dict("ref", reference, "action", action, "ok", true,
                            "value", ((ValuePattern)pattern).Current.Value ?? string.Empty);
                    }
                    if (el.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                    {
                        return Dict("ref", reference, "action", action, "ok", true,
                            "value", ((TextPattern)pattern).DocumentRange.GetText(4096) ?? string.Empty);
                    }
                    return Dict("ref", reference, "action", action, "ok", false,
                        "message", "element does not support Value or Text");
                case "focus":
                    try
                    {
                        el.SetFocus();
                        return Dict("ref", reference, "action", action, "ok", true);
                    }
                    catch (Exception ex)
                    {
                        return Dict("ref", reference, "action", action, "ok", false, "message", ex.Message);
                    }
                default:
                    throw new BridgeException("INVALID_ARGS", "unknown uia action '" + action + "'");
            }
        }

        // ------------------------------------------------------------------
        // clipboard (bridge process is STA, WinForms Clipboard is safe)
        // ------------------------------------------------------------------

        private static object ClipboardGet()
        {
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    var text = Clipboard.ContainsText() ? Clipboard.GetText() : string.Empty;
                    return Dict("text", text);
                }
                catch (Exception ex)
                {
                    if (attempt >= 1) throw new BridgeException("OP_FAILED", "clipboard busy: " + ex.Message);
                    System.Threading.Thread.Sleep(150);
                }
            }
        }

        private static object ClipboardSet(Dictionary<string, object> a)
        {
            if (!Has(a, "text")) throw new BridgeException("INVALID_ARGS", "text is required");
            var text = Str(a, "text", string.Empty);
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    Clipboard.SetText(text);
                    return Dict("ok", true);
                }
                catch (Exception ex)
                {
                    if (attempt >= 1) throw new BridgeException("OP_FAILED", "clipboard busy: " + ex.Message);
                    System.Threading.Thread.Sleep(150);
                }
            }
        }
    }

    /// <summary>
    /// Top-of-screen hosting strip: a black, click-through, always-on-top bar
    /// that tells the person at the keyboard that the agent is driving the
    /// desktop. It renders on its own STA thread with a private message loop, so
    /// the bridge keeps answering NDJSON while the strip is up, and it carries
    /// WS_EX_TRANSPARENT / WS_EX_NOACTIVATE so it can never swallow a click or
    /// steal focus. The thread is a background thread, so the strip also
    /// disappears the moment the bridge process exits: "hosting ended" does not
    /// depend on anyone calling overlay.hide.
    /// </summary>
    internal static class Overlay
    {
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int ULW_ALPHA = 0x00000002;
        private const byte AC_SRC_OVER = 0x00;
        private const byte AC_SRC_ALPHA = 0x01;

        internal const int StripWidth = 320;
        internal const int StripHeight = 46;
        internal const string DefaultText = "Deepseek Harness托管中";

        [StructLayout(LayoutKind.Sequential)]
        private struct SIZE { public int cx; public int cy; }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
            IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        private static readonly object Gate = new object();
        private static readonly System.Threading.ManualResetEventSlim Ready =
            new System.Threading.ManualResetEventSlim(false);
        private static System.Threading.Thread _thread;
        private static Control _pump;
        private static OverlayForm _form;
        private static volatile bool _visible;

        public static object Show(Dictionary<string, object> a)
        {
            var text = DefaultText;
            if (a != null && a.ContainsKey("text") && a["text"] != null)
            {
                var asked = Convert.ToString(a["text"]);
                if (!string.IsNullOrWhiteSpace(asked)) text = asked;
            }

            EnsureThread();
            if (!Ready.Wait(2500))
                throw new BridgeException("OVERLAY_UNAVAILABLE", "overlay thread did not become ready within 2.5s");

            Invoke(delegate
            {
                if (_form == null) _form = new OverlayForm(Position());
                _form.SetLabel(text);
                if (!_form.Visible) _form.Show();
                _form.Redraw();
            });
            _visible = true;
            return Dict("shown", true, "text", text, "width", StripWidth, "height", StripHeight);
        }

        public static object Hide()
        {
            if (_thread != null) Invoke(delegate { if (_form != null) _form.Hide(); });
            _visible = false;
            return Dict("shown", false);
        }

        public static object State()
        {
            return Dict("shown", _visible, "width", StripWidth, "height", StripHeight, "defaultText", DefaultText);
        }

        private static void EnsureThread()
        {
            if (_thread != null) return;
            lock (Gate)
            {
                if (_thread != null) return;
                var t = new System.Threading.Thread(ThreadMain);
                t.IsBackground = true;
                t.Name = "dsh-computer-use-overlay";
                t.SetApartmentState(System.Threading.ApartmentState.STA);
                t.Start();
                _thread = t;
            }
        }

        private static void ThreadMain()
        {
            try
            {
                // A bare control gives this thread a handle to marshal onto; the
                // context keeps the message loop alive without showing anything.
                _pump = new Control();
                _pump.CreateControl();
                if (!_pump.IsHandleCreated)
                    throw new BridgeException("OVERLAY_UNAVAILABLE", "could not create the overlay message pump");
                Ready.Set();
                Application.Run(new ApplicationContext());
            }
            catch
            {
                Ready.Set();
            }
        }

        private static void Invoke(Action action)
        {
            var pump = _pump;
            if (pump == null) { action(); return; }
            if (pump.InvokeRequired) pump.Invoke(action);
            else action();
        }

        private static POINT Position()
        {
            // A non-interactive session can have no primary screen at all; the
            // strip is best-effort, so fall back to a sane desktop instead of
            // failing the whole overlay op.
            var area = new Rectangle(0, 0, 0, 0);
            try
            {
                var screen = Screen.PrimaryScreen;
                if (screen != null) area = screen.WorkingArea;
            }
            catch { }
            if (area.Width <= 0 || area.Height <= 0) area = new Rectangle(0, 0, 1920, 1080);
            return new POINT { x = area.Left + (area.Width - StripWidth) / 2, y = area.Top + 8 };
        }

        private static Dictionary<string, object> Dict(params object[] pairs)
        {
            var d = new Dictionary<string, object>();
            for (var i = 0; i + 1 < pairs.Length; i += 2) d[Convert.ToString(pairs[i])] = pairs[i + 1];
            return d;
        }

        private sealed class OverlayForm : Form
        {
            private string _label = DefaultText;

            internal OverlayForm(POINT position)
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                TopMost = true;
                Size = new Size(StripWidth, StripHeight);
                Location = new Point(position.x, position.y);
                SetStyle(ControlStyles.Opaque | ControlStyles.UserPaint, true);
            }

            internal void SetLabel(string text)
            {
                _label = string.IsNullOrWhiteSpace(text) ? DefaultText : text;
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    var cp = base.CreateParams;
                    cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                    return cp;
                }
            }

            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                Redraw();
            }

            /// <summary>
            /// Paints the strip into a 32bpp ARGB bitmap and hands it to the
            /// compositor. That is what makes the ellipse edges smooth; a
            /// Region-clipped window would be visibly jagged.
            /// </summary>
            internal void Redraw()
            {
                if (!IsHandleCreated) return;
                using (var bmp = new Bitmap(StripWidth, StripHeight, PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(bmp))
                    {
                        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
                        g.Clear(Color.Transparent);
                        using (var path = new System.Drawing.Drawing2D.GraphicsPath())
                        {
                            path.AddEllipse(0, 0, StripWidth - 1, StripHeight - 1);
                            using (var fill = new SolidBrush(Color.FromArgb(235, 0, 0, 0)))
                                g.FillPath(fill, path);
                        }
                        using (var font = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Regular, GraphicsUnit.Point))
                        using (var brush = new SolidBrush(Color.White))
                        using (var format = new StringFormat
                        {
                            Alignment = StringAlignment.Center,
                            LineAlignment = StringAlignment.Center,
                            Trimming = StringTrimming.EllipsisCharacter
                        })
                        {
                            g.DrawString(_label, font, brush, new RectangleF(14, 0, StripWidth - 28, StripHeight), format);
                        }
                    }
                    ApplyLayered(bmp);
                }
            }

            private void ApplyLayered(Bitmap bmp)
            {
                var screenDc = GetDC(IntPtr.Zero);
                var memDc = CreateCompatibleDC(screenDc);
                var hBitmap = IntPtr.Zero;
                var previous = IntPtr.Zero;
                try
                {
                    hBitmap = bmp.GetHbitmap(Color.FromArgb(0));
                    previous = SelectObject(memDc, hBitmap);
                    var size = new SIZE { cx = StripWidth, cy = StripHeight };
                    var source = new POINT { x = 0, y = 0 };
                    var destination = new POINT { x = Left, y = Top };
                    var blend = new BLENDFUNCTION
                    {
                        BlendOp = AC_SRC_OVER,
                        BlendFlags = 0,
                        SourceConstantAlpha = 255,
                        AlphaFormat = AC_SRC_ALPHA
                    };
                    UpdateLayeredWindow(Handle, screenDc, ref destination, ref size, memDc, ref source, 0, ref blend, ULW_ALPHA);
                }
                finally
                {
                    if (previous != IntPtr.Zero) SelectObject(memDc, previous);
                    if (hBitmap != IntPtr.Zero) DeleteObject(hBitmap);
                    DeleteDC(memDc);
                    ReleaseDC(IntPtr.Zero, screenDc);
                }
            }
        }
    }
}
