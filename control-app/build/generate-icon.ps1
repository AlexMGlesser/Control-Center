# generate-icon.ps1
# Generates the Control Center application icon (icon.ico + icon.png).
# Design: 3×3 grid of connected squares on a dark teal background —
#         representing the control center's role as a hub for all your apps.
# Run once from any directory; writes output to the same folder as this script.

#Requires -Version 5.0
Add-Type -AssemblyName System.Drawing

$OutDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# ── C# helpers (rounded-rect geometry + icon renderer) ───────────────────────
$sysDrawingAsm = [System.Drawing.Bitmap].Assembly.Location

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

public static class IconHelper {

    // Build a rounded-rectangle GraphicsPath.
    public static GraphicsPath RoundedRect(float x, float y, float w, float h, float r) {
        var p = new GraphicsPath();
        if (r <= 0f) { p.AddRectangle(new RectangleF(x, y, w, h)); return p; }
        float r2 = r * 2f;
        p.AddArc(x,        y,        r2, r2, 180f, 90f);
        p.AddLine(x + r,   y,        x + w - r, y);
        p.AddArc(x+w-r2,   y,        r2, r2, 270f, 90f);
        p.AddLine(x + w,   y + r,    x + w, y + h - r);
        p.AddArc(x+w-r2,   y+h-r2,   r2, r2,   0f, 90f);
        p.AddLine(x+w-r,   y + h,    x + r, y + h);
        p.AddArc(x,        y+h-r2,   r2, r2,  90f, 90f);
        p.CloseFigure();
        return p;
    }

    // Render the icon at the requested pixel size.
    public static Bitmap DrawIcon(int S) {
        var bmp = new Bitmap(S, S, PixelFormat.Format32bppArgb);
        var g   = Graphics.FromImage(bmp);
        g.SmoothingMode      = SmoothingMode.AntiAlias;
        g.CompositingQuality = CompositingQuality.HighQuality;
        g.Clear(Color.Transparent);

        // ── Palette ─────────────────────────────────────────────────────────
        var cBg     = Color.FromArgb(255,  10,  22,  28);   // near-black teal
        var cBorder = Color.FromArgb(255,  22,  68,  86);   // subtle border
        var cHi     = Color.FromArgb(255,  52, 222, 246);   // bright cyan
        var cMid    = Color.FromArgb(210,  35, 160, 190);   // mid cyan
        var cDim    = Color.FromArgb(150,  24, 112, 140);   // dim cyan
        var cLine   = Color.FromArgb( 80,  52, 222, 246);   // ghost lines

        var brBg  = new SolidBrush(cBg);
        var brHi  = new SolidBrush(cHi);
        var brMid = new SolidBrush(cMid);
        var brDim = new SolidBrush(cDim);
        var penBdr = new Pen(cBorder, Math.Max(1f, S * 0.015f));
        var penLn  = new Pen(cLine,   Math.Max(1f, S * 0.024f));

        // ── Background (rounded square) ──────────────────────────────────────
        float bgR = S * 0.18f;
        var   bgP = RoundedRect(0.5f, 0.5f, S - 1f, S - 1f, bgR);
        g.FillPath(brBg, bgP);
        if (S >= 32) g.DrawPath(penBdr, bgP);

        // ── Grid geometry ───────────────────────────────────────────────────
        float sqSz  = S * 0.19f;
        float sqGap = S * 0.092f;
        float gridW = 3f * sqSz + 2f * sqGap;
        float ox    = (S - gridW) * 0.5f;
        float oy    = (S - gridW) * 0.5f;
        float sqRad = sqSz * 0.25f;

        // Center-point array for drawing connecting lines
        float[] cx = new float[9];
        float[] cy = new float[9];
        for (int r = 0; r < 3; r++)
            for (int c = 0; c < 3; c++) {
                cx[r*3+c] = ox + c*(sqSz+sqGap) + sqSz*0.5f;
                cy[r*3+c] = oy + r*(sqSz+sqGap) + sqSz*0.5f;
            }

        // ── Connection lines (grid edges) ───────────────────────────────────
        if (S >= 24) {
            // horizontal pairs then vertical pairs
            int[,] pairs = {
                {0,1},{1,2},{3,4},{4,5},{6,7},{7,8},
                {0,3},{3,6},{1,4},{4,7},{2,5},{5,8}
            };
            for (int k = 0; k < 12; k++)
                g.DrawLine(penLn, cx[pairs[k,0]], cy[pairs[k,0]],
                                  cx[pairs[k,1]], cy[pairs[k,1]]);
        }

        // ── Squares ─────────────────────────────────────────────────────────
        for (int r = 0; r < 3; r++)
            for (int c = 0; c < 3; c++) {
                float x = ox + c*(sqSz+sqGap);
                float y = oy + r*(sqSz+sqGap);
                float rad = (S >= 32) ? sqRad : 0f;
                var sqP = RoundedRect(x, y, sqSz, sqSz, rad);

                bool isCenter = (r == 1 && c == 1);
                bool isEdge   = (r == 1 || c == 1);
                if      (isCenter) g.FillPath(brHi,  sqP);
                else if (isEdge)   g.FillPath(brMid, sqP);
                else               g.FillPath(brDim, sqP);
                sqP.Dispose();
            }

        // ── Cleanup ──────────────────────────────────────────────────────────
        g.Dispose();
        brBg.Dispose(); brHi.Dispose(); brMid.Dispose(); brDim.Dispose();
        penBdr.Dispose(); penLn.Dispose(); bgP.Dispose();
        return bmp;
    }
}
"@ -ReferencedAssemblies $sysDrawingAsm

# ── Generate all icon sizes ───────────────────────────────────────────────────
$sizes  = @(16, 24, 32, 48, 64, 128, 256)
$chunks = [System.Collections.ArrayList]::new()

foreach ($sz in $sizes) {
    $bmp = [IconHelper]::DrawIcon($sz)
    $ms  = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [void]$chunks.Add($ms.ToArray())
    $bmp.Dispose()
    $ms.Dispose()
    Write-Host "  Generated ${sz}x${sz}" -ForegroundColor DarkCyan
}

# Save reference 256×256 PNG
$bigBmp = [IconHelper]::DrawIcon(256)
$bigBmp.Save("$OutDir\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bigBmp.Dispose()
Write-Host "  Saved reference: $OutDir\icon.png" -ForegroundColor DarkGray

# ── Write .ico (ICO container with embedded PNG images) ──────────────────────
$icoPath = "$OutDir\icon.ico"
$fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)
$n  = $sizes.Count

# ICONDIR header (6 bytes)
$bw.Write([uint16]0)    # reserved
$bw.Write([uint16]1)    # type = 1 (ICO)
$bw.Write([uint16]$n)   # image count

# Pre-compute data section offsets
$dataStart  = 6 + 16 * $n
$offsets    = New-Object int[] $n
$runningOff = $dataStart
for ($i = 0; $i -lt $n; $i++) {
    $offsets[$i] = $runningOff
    $runningOff += ([byte[]]$chunks[$i]).Length
}

# ICONDIRENTRY × n (16 bytes each)
for ($i = 0; $i -lt $n; $i++) {
    $sz   = $sizes[$i]
    $data = [byte[]]$chunks[$i]
    $wh   = [byte]($(if ($sz -ge 256) { 0 } else { $sz }))   # 0 signals 256 in ICO spec
    $bw.Write($wh)   # width
    $bw.Write($wh)   # height
    $bw.Write([byte]0)           # colorCount (0 = true color)
    $bw.Write([byte]0)           # reserved
    $bw.Write([uint16]1)         # planes
    $bw.Write([uint16]32)        # bit depth
    $bw.Write([uint32]$data.Length)   # image data size (bytes)
    $bw.Write([uint32]$offsets[$i])   # offset from start of file
}

# Image data section
for ($i = 0; $i -lt $n; $i++) {
    $data = [byte[]]$chunks[$i]
    $bw.Write($data, 0, $data.Length)
}

$bw.Close()
$fs.Close()
Write-Host "  Icon created: $icoPath" -ForegroundColor Green
