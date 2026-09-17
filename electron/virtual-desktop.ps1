$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TablineVirtualDesktop
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
    private static readonly Dictionary<string, IntPtr> WindowHandles = new Dictionary<string, IntPtr>();

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

    [ComImport]
    [Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IServiceProvider
    {
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object QueryService(ref Guid service, ref Guid interfaceId);
    }

    [ComImport]
    [Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationViewCollection
    {
        int GetViews(out IntPtr views);
        int GetViewsByZOrder(out IntPtr views);
        int GetViewsByAppUserModelId([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr views);
        int GetViewForHwnd(IntPtr hwnd, [MarshalAs(UnmanagedType.IUnknown)] out object view);
    }

    [ComImport]
    [Guid("3F07F4BE-B107-441A-AF0F-39D82529072C")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IVirtualDesktop
    {
        bool IsViewVisible([MarshalAs(UnmanagedType.IUnknown)] object view);
        Guid GetId();
    }

    [ComImport]
    [Guid("53F5CA0B-158F-4124-900C-057158060B27")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IVirtualDesktopManagerInternal
    {
        int GetCount();
        void MoveViewToDesktop([MarshalAs(UnmanagedType.IUnknown)] object view, IVirtualDesktop desktop);
        bool CanViewMoveDesktops([MarshalAs(UnmanagedType.IUnknown)] object view);
        IVirtualDesktop GetCurrentDesktop();
        void GetDesktops(out IntPtr desktops);
        int GetAdjacentDesktop(IVirtualDesktop from, int direction, out IVirtualDesktop desktop);
        void SwitchDesktop(IVirtualDesktop desktop);
        void SwitchDesktopAndMoveForegroundView(IVirtualDesktop desktop);
        IVirtualDesktop CreateDesktop();
        void MoveDesktop(IVirtualDesktop desktop, int index);
        void RemoveDesktop(IVirtualDesktop desktop, IVirtualDesktop fallback);
        IVirtualDesktop FindDesktop(ref Guid desktopId);
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);

    private static IntPtr FindWindow(string windowId, int processId, int left, int top, int width, int height)
    {
        var staleKeys = new List<string>();
        foreach (var pair in WindowHandles)
        {
            uint owner;
            if (!IsWindow(pair.Value)) staleKeys.Add(pair.Key);
            else { GetWindowThreadProcessId(pair.Value, out owner); if (owner != (uint)processId) staleKeys.Add(pair.Key); }
        }
        foreach (var key in staleKeys) WindowHandles.Remove(key);

        IntPtr cached;
        uint cachedOwner;
        if (WindowHandles.TryGetValue(windowId, out cached) && IsWindow(cached))
        {
            GetWindowThreadProcessId(cached, out cachedOwner);
            if (cachedOwner == (uint)processId) return cached;
        }
        WindowHandles.Remove(windowId);

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
            if (WindowHandles.ContainsValue(hwnd)) continue;
            Rect rect;
            if (DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(hwnd, out rect)) continue;
            long distance = Math.Abs((long)rect.Left - left) + Math.Abs((long)rect.Top - top)
                + Math.Abs((long)(rect.Right - rect.Left) - width) + Math.Abs((long)(rect.Bottom - rect.Top) - height);
            if (distance < bestDistance) { best = hwnd; bestDistance = distance; }
        }
        if (best != IntPtr.Zero) WindowHandles[windowId] = best;
        return best;
    }

    public static string Resolve(string windowId, int processId, int left, int top, int width, int height)
    {
        var best = FindWindow(windowId, processId, left, top, width, height);
        if (best == IntPtr.Zero) return null;

        var type = Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"));
        var manager = (IVirtualDesktopManager)Activator.CreateInstance(type);
        try { return manager.GetWindowDesktopId(best).ToString("D"); }
        finally { Marshal.FinalReleaseComObject(manager); }
    }

    public static bool Move(string windowId, int processId, int left, int top, int width, int height, string desktopId)
    {
        Guid targetId;
        if (!Guid.TryParse(desktopId, out targetId)) return false;
        var hwnd = FindWindow(windowId, processId, left, top, width, height);
        if (hwnd == IntPtr.Zero) return false;

        var shellType = Type.GetTypeFromCLSID(new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239"));
        var shell = (IServiceProvider)Activator.CreateInstance(shellType);
        var managerService = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
        var managerInterface = typeof(IVirtualDesktopManagerInternal).GUID;
        var viewsService = typeof(IApplicationViewCollection).GUID;
        var manager = (IVirtualDesktopManagerInternal)shell.QueryService(ref managerService, ref managerInterface);
        var views = (IApplicationViewCollection)shell.QueryService(ref viewsService, ref viewsService);
        object view = null;
        IVirtualDesktop desktop = null;
        try
        {
            if (views.GetViewForHwnd(hwnd, out view) != 0 || view == null) return false;
            desktop = manager.FindDesktop(ref targetId);
            if (desktop == null) return false;
            manager.MoveViewToDesktop(view, desktop);
            return true;
        }
        finally
        {
            if (desktop != null) Marshal.FinalReleaseComObject(desktop);
            if (view != null) Marshal.FinalReleaseComObject(view);
            Marshal.FinalReleaseComObject(views);
            Marshal.FinalReleaseComObject(manager);
            Marshal.FinalReleaseComObject(shell);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $request = $line | ConvertFrom-Json
        $bounds = $request.bounds
        if ($request.action -eq 'move') {
            $moved = [TablineVirtualDesktop]::Move([string]$request.windowId, [int]$request.processId, [int]$bounds.left, [int]$bounds.top, [int]$bounds.width, [int]$bounds.height, [string]$request.desktopId)
            @{ id = $request.id; moved = $moved } | ConvertTo-Json -Compress
        } else {
            $desktopId = [TablineVirtualDesktop]::Resolve([string]$request.windowId, [int]$request.processId, [int]$bounds.left, [int]$bounds.top, [int]$bounds.width, [int]$bounds.height)
            @{ id = $request.id; desktopId = $desktopId } | ConvertTo-Json -Compress
        }
    } catch {
        @{ id = $request.id; desktopId = $null; moved = $false } | ConvertTo-Json -Compress
    }
    [Console]::Out.Flush()
}
