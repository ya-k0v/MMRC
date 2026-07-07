using System;
using System.Windows;
using System.Windows.Interop;

namespace MMRCPlayer;

public partial class OverlayWindow : Window
{
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_TOOLWINDOW = 0x00000080;

    public event Action? OnDoubleClick;

    public OverlayWindow()
    {
        InitializeComponent();
        Loaded += OverlayWindow_Loaded;
    }

    private void OverlayWindow_Loaded(object sender, RoutedEventArgs e)
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        var exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle | WS_EX_TOOLWINDOW);
    }

    public void SetText(string text) => OverlayText.Text = text;

    public void UpdatePosition(double left, double top)
    {
        Left = left;
        Top = top;
    }

    private void OverlayWindow_MouseDoubleClick(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        e.Handled = true;
        if (Owner is MainWindow mw && mw.IsLoaded)
            OnDoubleClick?.Invoke();
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hwnd, int index);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hwnd, int index, int newStyle);
}
