# zjl-Achat system tray manager (v2rayN-style).
# UI strings are Chinese; save this file as UTF-8 WITH BOM so Windows
# PowerShell 5.1 reads it correctly (no BOM = GBK mojibake in menus).
# Desktop shortcut runs this. It starts the achat server + opens the native
# Edge app window, then lives in the systray. Closing/minimizing the window
# does NOT kill the server; right-click tray -> Exit kills everything.
# Every step is logged to desktop/tray-boot.log for diagnosis.
#Requires -Version 5.1
$ErrorActionPreference = 'Continue'

# Repo root = parent of the desktop/ folder this script lives in.
$ROOT = Split-Path -Parent $PSScriptRoot
$PORT = 8787
$URL  = "http://127.0.0.1:$PORT"
# Locate node.exe: PATH first, then common install locations.
$NODE = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NODE) {
  $NODE = @(
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:ProgramFiles\nodejs\node.exe",
    'C:\Program Files (x86)\nodejs\node.exe'
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $NODE) {
  Write-Host 'node.exe not found in PATH or common locations.'
  exit 1
}
$EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$LOG  = Join-Path $ROOT 'desktop/tray-boot.log'

function Log($m) {
  try { "[$(Get-Date -Format 'HH:mm:ss')] $m" | Out-File -Append -FilePath $LOG -Encoding utf8 } catch {}
}
Log "=== tray start (pid $PID) ==="

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch { Log "Add-Type error: $_"; exit 1 }

# Hide our own console window ASAP. Double-clicking / "Run with PowerShell"
# pops a black console box that would otherwise stay visible for the whole
# tray lifetime. SW_HIDE = 0; the process keeps running while hidden.
try {
  Add-Type -Namespace Win32 -Name Wnd -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);'
  $me = Get-Process -Id $PID
  if ($me.MainWindowHandle -ne [IntPtr]::Zero) { [Win32.Wnd]::ShowWindow($me.MainWindowHandle, 0) | Out-Null }
} catch { Log "hide-console error: $_" }

function Test-Port {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $ar = $tcp.BeginConnect('127.0.0.1', $PORT, $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(800)
    $tcp.Close()
    return $ok
  } catch { return $false }
}
function Get-PortPid {
  $line = netstat -ano | Where-Object { $_ -match ":$PORT\s+.*LISTENING\s+(\d+)" }
  if ($line) { return [int]($line -replace '.*LISTENING\s+(\d+).*', '$1') }
  return $null
}
function Get-EdgeAppPid {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine -like "*app=http://127.0.0.1:$PORT*") { $_.ProcessId }
  } | Select-Object -First 1
}
function Start-Server {
  if (Test-Port) { Log 'server already up, skip'; return $true }
  Log 'starting server...'
  try {
    $p = Start-Process -FilePath $NODE -ArgumentList 'server/server.mjs' -WorkingDirectory $ROOT -WindowStyle Hidden -PassThru -ErrorAction Stop
    Log "server launched pid=$($p.Id)"
  } catch { Log "start server FAILED: $_"; return $false }
  $t = 0
  while (-not (Test-Port) -and $t -lt 40) { Start-Sleep -Milliseconds 500; $t++ }
  if (Test-Port) { Log "server up after $([math]::Round($t*0.5,1))s"; return $true }
  Log 'server FAILED to come up within 20s'; return $false
}
function Start-Edge {
  if (Get-EdgeAppPid) { Log 'edge app already open, skip'; return $true }
  Log 'opening edge app window...'
  try { Start-Process -FilePath $EDGE -ArgumentList "--app=$URL","--new-window" -ErrorAction Stop; Log 'edge launched'; return $true }
  catch { Log "edge FAILED: $_"; return $false }
}

# single-instance: if another host of this script is already tray-running,
# just open the window and exit (no duplicate tray icons).
$otherTray = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -like '*tray.ps1*'
}
if ($otherTray) { Log 'another tray host already running -> just open window'; Start-Edge; exit 0 }

$serverOk = Start-Server
$edgeOk = Start-Edge
if (-not $serverOk) { Log 'WARN: server not up; tray still starts so you can retry via Open' }

# ---- tray UI in a dedicated STA runspace ----
# KEY FIX: a PowerShell scriptblock does NOT reliably execute on a raw
# System.Threading.Thread (the thread terminates instantly, no error, and
# Application.Run() never blocks). Running the scriptblock inside an STA
# PowerShell runspace is the supported way to host WinForms from PowerShell
# and makes Application.Run() actually block until Exit.
$trayCode = { param($root, $node)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $ROOT = $root
    $PORT = 8787
    $URL  = "http://127.0.0.1:$PORT"
    $EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    $iconPath = Join-Path $ROOT 'desktop/icon.ico'

    if (Test-Path $iconPath) { $icon = New-Object System.Drawing.Icon($iconPath) }
    else { try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($EDGE) } catch { $icon = [System.Drawing.SystemIcons]::Application } }

    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon = $icon
    $tray.Text = 'zjl-Achat 智能体群聊'
    $tray.Visible = $true

    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $openItem = $menu.Items.Add('打开 zjl-Achat')
    $openItem.Add_Click({ param($s,$e) Start-Process -FilePath $EDGE -ArgumentList "--app=$URL","--new-window" })

    $statusItem = $menu.Items.Add("状态：服务运行中（端口 $PORT）")
    $statusItem.Enabled = $false

    $menu.Items.Add('-') | Out-Null
    $exitItem = $menu.Items.Add('退出')
    $exitItem.Add_Click({
      param($s,$e)
      $epid = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*app=http://127.0.0.1:$PORT*" } | Select-Object -First 1 ProcessId
      if ($epid) { Stop-Process -Id $epid -Force -ErrorAction SilentlyContinue }
      $pid2 = netstat -ano | Where-Object { $_ -match ":$PORT\s+.*LISTENING\s+(\d+)" }
      if ($pid2) { Stop-Process -Id ([int]($pid2 -replace '.*LISTENING\s+(\d+).*','$1')) -Force -ErrorAction SilentlyContinue }
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/server.mjs*' -and $_.CommandLine -like "*$ROOT*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      $tray.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    })

    $tray.ContextMenuStrip = $menu
    $tray.Add_DoubleClick({ param($s,$e) Start-Process -FilePath $EDGE -ArgumentList "--app=$URL","--new-window" })
    $tray.ShowBalloonTip(3000, 'zjl-Achat 智能体群聊', '已启动，常驻系统托盘（右键可退出）', 'Info')

    # ---- watchdog: auto-relaunch the server if it dies ----
    # Runs as a WinForms Timer on the tray UI thread (safe with Application.Run).
    # A crashed / killed node process is detected within 30s and restarted
    # hidden; the menu status line reflects live state. Manual "Open" retry is
    # no longer the only recovery path.
    function Test-ServerUp {
      try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $ar = $tcp.BeginConnect('127.0.0.1', $PORT, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(800)
        $tcp.Close()
        return $ok
      } catch { return $false }
    }
    $watchNode = $node
    $script:wdDown = 0
    $watchdog = New-Object System.Windows.Forms.Timer
    $watchdog.Interval = 30000
    $watchdog.Add_Tick({
      try {
        if (Test-ServerUp) { $script:wdDown = 0 }
        else {
          $script:wdDown++
          try { "[$(Get-Date -Format 'HH:mm:ss')] watchdog: server down (x$script:wdDown), relaunching" | Out-File -Append -FilePath (Join-Path $ROOT 'desktop/tray-boot.log') -Encoding utf8 } catch {}
          Start-Process -FilePath $watchNode -ArgumentList 'server/server.mjs' -WorkingDirectory $ROOT -WindowStyle Hidden | Out-Null
        }
        $up = Test-ServerUp
        $statusItem.Text = if ($up) { "状态：服务运行中（端口 $PORT）" } else { "状态：服务未响应（30 秒内自动重启）" }
      } catch {
        try { "[$(Get-Date -Format 'HH:mm:ss')] watchdog error: $_" | Out-File -Append -FilePath (Join-Path $ROOT 'desktop/tray-boot.log') -Encoding utf8 } catch {}
      }
    })
    $watchdog.Start()

    [System.Windows.Forms.Application]::Run()
  } catch {
    try { "[$(Get-Date -Format 'HH:mm:ss')] TRAY RUNSPACE ERROR: $_" | Out-File -Append -FilePath (Join-Path $ROOT 'desktop/tray-boot.log') -Encoding utf8 } catch {}
  }
}

try {
  $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
  $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace($iss)
  $rs.ApartmentState = 'STA'
  $rs.Open()
  $ps = [System.Management.Automation.PowerShell]::Create()
  $ps.Runspace = $rs
  [void]$ps.AddScript($trayCode).AddArgument($ROOT).AddArgument($NODE)
  Log 'tray runspace opened (STA), invoking'
  $async = $ps.BeginInvoke()
  Log 'tray running, main thread waiting...'
  $ps.EndInvoke($async)
  Log 'tray runspace ended'
  $rs.Close()
} catch {
  Log "TRAY HOST ERROR: $_"
}
