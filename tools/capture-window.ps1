<#
  Captures a real PNG of a running window, selected by process executable path.

  Used by the screenshot suite (src/test/screenshot/capture.test.ts) to
  photograph the extension's actual UI inside the isolated @vscode/test-electron
  instance. The extension host's own process.execPath IS that instance's
  Code.exe, which is what makes "find the window belonging to this exact binary"
  precise: a normally-installed VS Code lives at a different path and can never
  be picked up by mistake.

  Two capture paths are tried, in order:
    1. PrintWindow(PW_RENDERFULLCONTENT) - asks the window to render itself, so
       it works even when something is sitting on top of it.
    2. BitBlt from the screen DC - the fallback, for when Chromium hands
       PrintWindow a blank surface.

  A capture is only accepted if it is not blank; "blank" is measured by sampling
  a grid and counting distinct colours.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/capture-window.ps1
      -ExePath <...\Code.exe> -Mode arrange -Width 1440 -Height 900
    powershell ... -ExePath <...\Code.exe> -Mode capture -Out images/screenshot.png

  Prints one line of JSON on success. Exits non-zero with a message on failure.
#>
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [ValidateSet('arrange', 'capture', 'diagnose')][string]$Mode = 'capture',
  [string]$Out = '',
  [int]$Width = 1440,
  [int]$Height = 900,
  # Rows to shave off the top of the finished capture. Used to drop the title
  # bar, which under the test harness reads "[Extension Development Host] ...".
  [int]$CropTop = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCap {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT val, int size);

  public const uint GW_OWNER = 4;
  public const int SW_RESTORE = 9;
  public const uint PW_RENDERFULLCONTENT = 2;

  // Top-level, visible, un-owned, titled windows only. That skips Chromium's
  // hidden helper and tooltip windows, which also belong to Code.exe.
  public static IntPtr[] Candidates(uint pid) {
    System.Collections.Generic.List<IntPtr> found = new System.Collections.Generic.List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
      if (GetWindowTextLength(h) == 0) return true;
      found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }

  public static string Title(IntPtr h) {
    int n = GetWindowTextLength(h);
    StringBuilder sb = new StringBuilder(n + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static int Area(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return -1;
    return (r.Right - r.Left) * (r.Bottom - r.Top);
  }

  // The visible bounds, excluding the invisible resize border Windows keeps
  // around a window. Cropping to this is the difference between a clean
  // screenshot and one with transparent margins down two edges.
  public static RECT VisibleBounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.Right > r.Left) return r;
    GetWindowRect(h, out r);
    return r;
  }

  public static RECT FullBounds(IntPtr h) {
    RECT r;
    GetWindowRect(h, out r);
    return r;
  }
}
"@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing

[void][WinCap]::SetProcessDPIAware()

function Get-Candidates {
  param([string]$Exe)

  $normalised = [System.IO.Path]::GetFullPath($Exe)
  $found = @()
  foreach ($proc in Get-Process) {
    $path = $null
    try { $path = $proc.Path } catch { $path = $null }
    if (-not $path) { continue }
    if ($path -ine $normalised) { continue }
    foreach ($hwnd in [WinCap]::Candidates([uint32]$proc.Id)) {
      $r = [WinCap]::FullBounds($hwnd)
      $w = $r.Right - $r.Left
      $h = $r.Bottom - $r.Top
      # Chromium keeps small titled helper windows around next to the real
      # workbench, so size is what separates them - not title, which matches.
      $rank = if ($w -ge 300 -and $h -ge 200) { 2 } else { 1 }
      $found += [pscustomobject]@{
        Hwnd  = $hwnd
        Owner = $proc.Id
        Title = [WinCap]::Title($hwnd)
        Width = $w
        Height = $h
        Area  = ($w * $h)
        Rank  = $rank
      }
    }
  }
  return @($found | Sort-Object -Property Rank, Area -Descending)
}

function Get-TargetWindow {
  param([string]$Exe)

  $found = Get-Candidates -Exe $Exe
  if ($found.Count -eq 0) {
    throw "no visible top-level window belongs to $([System.IO.Path]::GetFullPath($Exe))"
  }
  return $found[0]
}

function Format-Candidates {
  param($Found)
  return @($Found | ForEach-Object { "$($_.Width)x$($_.Height) pid=$($_.Owner) '$($_.Title)'" })
}

# Distinct colours over a sampled grid. A window that rendered nothing comes
# back as one flat colour; a real workbench comes back with hundreds.
function Measure-Colours {
  param([System.Drawing.Bitmap]$Bitmap)

  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $stepX = [Math]::Max(1, [int]($Bitmap.Width / 48))
  $stepY = [Math]::Max(1, [int]($Bitmap.Height / 48))
  for ($x = 0; $x -lt $Bitmap.Width; $x += $stepX) {
    for ($y = 0; $y -lt $Bitmap.Height; $y += $stepY) {
      [void]$seen.Add($Bitmap.GetPixel($x, $y).ToArgb())
    }
  }
  return $seen.Count
}

function Invoke-PrintWindow {
  param($Hwnd)

  $full = [WinCap]::FullBounds($Hwnd)
  $w = $full.Right - $full.Left
  $h = $full.Bottom - $full.Top
  if ($w -le 0 -or $h -le 0) { return $null }

  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $gfx.GetHdc()
  $ok = [WinCap]::PrintWindow($Hwnd, $hdc, [WinCap]::PW_RENDERFULLCONTENT)
  $gfx.ReleaseHdc($hdc)
  $gfx.Dispose()
  if (-not $ok) { $bmp.Dispose(); return $null }

  $vis = [WinCap]::VisibleBounds($Hwnd)
  $crop = New-Object System.Drawing.Rectangle(
    ($vis.Left - $full.Left),
    ($vis.Top - $full.Top),
    ($vis.Right - $vis.Left),
    ($vis.Bottom - $vis.Top))
  $crop.Intersect((New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
  if ($crop.Width -le 0 -or $crop.Height -le 0) { return $bmp }

  $cropped = $bmp.Clone($crop, $bmp.PixelFormat)
  $bmp.Dispose()
  return $cropped
}

function Invoke-ScreenGrab {
  param($Hwnd)

  $vis = [WinCap]::VisibleBounds($Hwnd)
  $w = $vis.Right - $vis.Left
  $h = $vis.Bottom - $vis.Top
  if ($w -le 0 -or $h -le 0) { return $null }

  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($vis.Left, $vis.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $gfx.Dispose()
  return $bmp
}

$candidates = Get-Candidates -Exe $ExePath

if ($Mode -eq 'diagnose') {
  Write-Output (ConvertTo-Json -Compress @{
      mode  = 'diagnose'
      scale = ([WinCap]::GetDpiForSystem() / 96.0)
      candidates = (Format-Candidates -Found $candidates)
    })
  exit 0
}

$target = Get-TargetWindow -Exe $ExePath

if ($Mode -eq 'arrange') {
  if ([WinCap]::IsIconic($target.Hwnd)) {
    [void][WinCap]::ShowWindow($target.Hwnd, [WinCap]::SW_RESTORE)
  }
  # Keep the window on the screen, so the BitBlt fallback stays usable.
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $w = [Math]::Min($Width, $area.Width)
  $h = [Math]::Min($Height, $area.Height)
  [void][WinCap]::MoveWindow($target.Hwnd, $area.X, $area.Y, $w, $h, $true)
  [void][WinCap]::SetForegroundWindow($target.Hwnd)
  Start-Sleep -Milliseconds 400
  [void][WinCap]::SetForegroundWindow($target.Hwnd)

  $r = [WinCap]::VisibleBounds($target.Hwnd)
  Write-Output (ConvertTo-Json -Compress @{
      mode   = 'arrange'
      hwnd   = [string]$target.Hwnd
      owner  = $target.Owner
      title  = $target.Title
      width  = ($r.Right - $r.Left)
      height = ($r.Bottom - $r.Top)
      scale  = ([WinCap]::GetDpiForSystem() / 96.0)
      candidates = (Format-Candidates -Found $candidates)
    })
  exit 0
}

if (-not $Out) { throw '-Out is required in capture mode' }
$outFull = [System.IO.Path]::GetFullPath($Out)
[void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($outFull))

[void][WinCap]::SetForegroundWindow($target.Hwnd)
Start-Sleep -Milliseconds 600

$attempts = @()
$bitmap = $null
$method = ''

foreach ($try in @('printwindow', 'screen')) {
  if ($try -eq 'printwindow') {
    $candidate = Invoke-PrintWindow -Hwnd $target.Hwnd
  }
  else {
    $candidate = Invoke-ScreenGrab -Hwnd $target.Hwnd
  }
  if (-not $candidate) {
    $attempts += ($try + ': no bitmap')
    continue
  }
  $colours = Measure-Colours -Bitmap $candidate
  $attempts += ($try + ': ' + $candidate.Width + 'x' + $candidate.Height + ', ' + $colours + ' distinct colours')
  if ($colours -ge 24) {
    $bitmap = $candidate
    $method = $try
    break
  }
  $candidate.Dispose()
}

if (-not $bitmap) {
  throw ('every capture path came back blank -> ' + ($attempts -join '; ') +
    ' | windows seen: ' + ((Format-Candidates -Found $candidates) -join '; '))
}

if ($CropTop -gt 0) {
  if ($CropTop -ge $bitmap.Height) { throw "-CropTop $CropTop is taller than the capture" }
  $keep = New-Object System.Drawing.Rectangle(0, $CropTop, $bitmap.Width, ($bitmap.Height - $CropTop))
  $trimmed = $bitmap.Clone($keep, $bitmap.PixelFormat)
  $bitmap.Dispose()
  $bitmap = $trimmed
}

$bitmap.Save($outFull, [System.Drawing.Imaging.ImageFormat]::Png)
$savedWidth = $bitmap.Width
$savedHeight = $bitmap.Height
$bitmap.Dispose()

Write-Output (ConvertTo-Json -Compress @{
    mode     = 'capture'
    method   = $method
    path     = $outFull
    scale    = ([WinCap]::GetDpiForSystem() / 96.0)
    cropTop  = $CropTop
    width    = $savedWidth
    height   = $savedHeight
    bytes    = (Get-Item $outFull).Length
    title    = $target.Title
    owner    = $target.Owner
    attempts = $attempts
  })
