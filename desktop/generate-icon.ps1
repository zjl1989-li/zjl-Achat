# generate-icon.ps1 - draw the zjl-Achat 3-circle icon (deep theme) with GDI+,
# emit multi-size PNGs + a multi-size ICO (Vista PNG-compressed format).
# Pure .NET, no external deps. Colors match docs/icon-r2-tri-color.svg.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ROOT = 'D:/Projects/zjl-achat'

function New-IconBitmap([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap($S, $S)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $f = $S / 64.0
  # rounded square bg
  $r = 14.0 * $f
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $x = 2.0 * $f; $y = 2.0 * $f; $w = 60.0 * $f; $h = 60.0 * $f
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x1B, 0x1C, 0x1F))
  $g.FillPath($bg, $path)
  # three circles (vivid high-sat palette) + dark separator strokes
  $colors = @(
    @(0x1D, 0xE5, 0xA0),  # teal
    @(0x2E, 0x7B, 0xFF),  # blue
    @(0xFF, 0xB0, 0x20)   # amber
  )
  $centers = @(
    @(23.0, 27.0),
    @(41.0, 27.0),
    @(32.0, 42.0)
  )
  for ($i = 0; $i -lt 3; $i++) {
    $c = $colors[$i]; $cc = $centers[$i]
    $br = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242, $c[0], $c[1], $c[2]))
    $cx = $cc[0] * $f; $cy = $cc[1] * $f; $rr = 13.0 * $f
    $g.FillEllipse($br, $cx - $rr, $cy - $rr, $rr * 2, $rr * 2)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 0x1B, 0x1C, 0x1F), [Math]::Max(1.0, 1.2 * $f))
    $g.DrawEllipse($pen, $cx - $rr, $cy - $rr, $rr * 2, $rr * 2)
    $br.Dispose(); $pen.Dispose()
  }
  # center accent dot (red)
  $dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0xFF, 0x3B, 0x30))
  $dr = 4.2 * $f
  $g.FillEllipse($dot, 32.0 * $f - $dr, 32.0 * $f - $dr, $dr * 2, $dr * 2)
  $dot.Dispose(); $bg.Dispose(); $path.Dispose()
  $g.Dispose()
  return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return $ms.ToArray()
}

# ---- emit PNGs ----
$sizes = @(16, 32, 48, 64, 128, 256)
$pngBytes = @{}
foreach ($s in $sizes) {
  $bmp = New-IconBitmap $s
  $pngBytes[$s] = Get-PngBytes $bmp
  if ($s -eq 256) { $bmp.Save((Join-Path $ROOT 'desktop/icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  if ($s -eq 32)  { $bmp.Save((Join-Path $ROOT 'public/favicon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
}

# ---- assemble multi-size ICO (Vista PNG-compressed) ----
$n = $sizes.Count
$iconDir = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($iconDir)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$n)
$offset = 6 + 16 * $n
foreach ($s in $sizes) {
  $data = $pngBytes[$s]
  $dim = if ($s -eq 256) { 0 } else { $s }   # 0 = 256 in ICO dir
  $bw.Write([byte]$dim)                       # width
  $bw.Write([byte]$dim)                       # height
  $bw.Write([byte]0)                          # color count
  $bw.Write([byte]0)                          # reserved
  $bw.Write([uint16]1)                        # planes
  $bw.Write([uint16]32)                       # bpp
  $bw.Write([uint32]$data.Length)             # bytes in res
  $bw.Write([uint32]$offset)                  # image offset
  $offset += $data.Length
}
foreach ($s in $sizes) { foreach ($b in $pngBytes[$s]) { $bw.Write([byte]$b) } }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $ROOT 'desktop/icon.ico'), $iconDir.ToArray())
$bw.Dispose(); $iconDir.Dispose()
Write-Output "OK: desktop/icon.ico ($((Get-Item (Join-Path $ROOT 'desktop/icon.ico')).Length) bytes), desktop/icon.png, public/favicon.png"
