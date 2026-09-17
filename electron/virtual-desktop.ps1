$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TablineVirtualDesktop
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [ComImport]
    [Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)]
        bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
        Guid GetWindowDesktopId(IntPtr topLevelWindow);
        void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);

    public static string Resolve(int processId, int left, int top, int width, int height)
    {
        var windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == (uint)processId) windows.Add(hwnd);
            return true;
        }, IntPtr.Zero);

        IntPtr best = IntPtr.Zero;
        long bestDistance = long.MaxValue;
        foreach (var hwnd in windows)
        {
            Rect rect;
            if (DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(hwnd, out rect)) continue;
            long distance = Math.Abs((long)rect.Left - left) + Math.Abs((long)rect.Top - top)
                + Math.Abs((long)(rect.Right - rect.Left) - width) + Math.Abs((long)(rect.Bottom - rect.Top) - height);
            if (distance < bestDistance) { best = hwnd; bestDistance = distance; }
        }
        if (best == IntPtr.Zero) return null;

        var type = Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"));
        var manager = (IVirtualDesktopManager)Activator.CreateInstance(type);
        try { return manager.GetWindowDesktopId(best).ToString("D"); }
        finally { Marshal.FinalReleaseComObject(manager); }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $request = $line | ConvertFrom-Json
        $bounds = $request.bounds
        $desktopId = [TablineVirtualDesktop]::Resolve(
            [int]$request.processId,
            [int]$bounds.left,
            [int]$bounds.top,
            [int]$bounds.width,
            [int]$bounds.height
        )
        @{ id = $request.id; desktopId = $desktopId } | ConvertTo-Json -Compress
    } catch {
        @{ id = $request.id; desktopId = $null } | ConvertTo-Json -Compress
    }
    [Console]::Out.Flush()
}
