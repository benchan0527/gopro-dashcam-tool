# DDpai Z90 Pro Dashcam Merger
# Merges all MP4s in N:\Dashcam\64 into one large MP4 using TS intermediate format.
# Output: N:\Dashcam\64_merged\dashcam_merged_YYYYMMDD_HHmmss.mp4

$ErrorActionPreference = 'Stop'

# ===== Config =====
$SOURCE_DIR    = 'N:\Dashcam\64'
$OUTPUT_DIR    = 'N:\Dashcam\64_merged'
$TIMESTAMP     = Get-Date -Format 'yyyyMMdd_HHmmss'
$FINAL_MP4     = Join-Path $OUTPUT_DIR ('dashcam_merged_{0}.mp4' -f $TIMESTAMP)
$FILELIST_TXT  = Join-Path $OUTPUT_DIR 'filelist_ts.txt'

Write-Host ''
Write-Host '=== DDpai Z90 Pro Dashcam Merger ===' -ForegroundColor Cyan
Write-Host ('Source : {0}' -f $SOURCE_DIR) -ForegroundColor Gray
Write-Host ('Output : {0}' -f $FINAL_MP4) -ForegroundColor Gray
Write-Host ''

# ===== Step 0: Make output dir =====
if (-not (Test-Path $OUTPUT_DIR)) {
    New-Item -ItemType Directory -Path $OUTPUT_DIR -Force | Out-Null
}

# ===== Step 1: Collect MP4s sorted by filename (Z90 uses YYYYMMDDhhmmss so sort is chronological) =====
$mp4s = Get-ChildItem -Path $SOURCE_DIR -File |
    Where-Object { $_.Extension -match '^\.(mp4|MP4)$' } |
    Sort-Object Name

if ($mp4s.Count -eq 0) {
    Write-Host 'No MP4 files found.' -ForegroundColor Red
    exit 1
}

$totalBytes = ($mp4s | Measure-Object Length -Sum).Sum
$totalGB    = [math]::Round($totalBytes / 1GB, 2)

Write-Host ('Found {0} files, total {1} GB' -f $mp4s.Count, $totalGB) -ForegroundColor Yellow
Write-Host ('  First : {0}' -f $mp4s[0].Name) -ForegroundColor Gray
Write-Host ('  Last  : {0}' -f $mp4s[-1].Name) -ForegroundColor Gray
Write-Host ''

# ===== Step 2: Convert each MP4 -> TS (lossless copy, video + first audio only) =====
Write-Host '[1/3] Converting MP4 -> TS (this takes most of the time)...' -ForegroundColor Yellow

$tsFiles = New-Object System.Collections.Generic.List[string]
$i = 0
foreach ($v in $mp4s) {
    $i++
    $tsFile = Join-Path $OUTPUT_DIR (('part{0:D4}.ts' -f $i))
    [void]$tsFiles.Add($tsFile)

    if (Test-Path $tsFile) {
        Write-Host ('  [{0:D3}/{1:D3}] skip (exists): {2}' -f $i, $mp4s.Count, $v.Name) -ForegroundColor DarkGray
        continue
    }

    $pct = [math]::Round(($i / $mp4s.Count) * 100, 1)
    Write-Host ('  [{0:D3}/{1:D3}] {2,5}% {3}' -f $i, $mp4s.Count, $pct, $v.Name) -ForegroundColor Green

    & ffmpeg -y -nostdin -hide_banner -loglevel error `
        -i $v.FullName `
        -c copy -map '0:v:0' -map '0:a:0?' `
        -f mpegts $tsFile 2>&1 | Out-Null

    if ($LASTEXITCODE -ne 0) {
        Write-Host ('    FAILED: {0}' -f $v.Name) -ForegroundColor Red
    }
}

# ===== Step 3: Concatenate all TS into final MP4 =====
Write-Host ''
Write-Host '[2/3] Concatenating TS segments into final MP4...' -ForegroundColor Yellow

# Build filelist using UTF8 *no* BOM
$sb = New-Object System.Text.StringBuilder
foreach ($ts in $tsFiles) {
    [void]$sb.AppendLine(('file ''{0}''' -f $ts.Replace('\', '/')))
}
[System.IO.File]::WriteAllText($FILELIST_TXT, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))

$ffmpegArgs = @(
    '-y', '-nostdin', '-hide_banner', '-loglevel', 'info',
    '-f', 'concat', '-safe', '0',
    '-i', $FILELIST_TXT,
    '-c', 'copy',
    '-fflags', '+genpts',
    $FINAL_MP4
)

$stdoutLog = Join-Path $env:TEMP 'ffmpeg_out.txt'
$stderrLog = Join-Path $env:TEMP 'ffmpeg_err.txt'
Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath 'ffmpeg' -ArgumentList $ffmpegArgs -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

while (-not $proc.HasExited) {
    Start-Sleep -Seconds 3
    if (Test-Path $stderrLog) {
        $tail = Get-Content $stderrLog -Tail 8 -ErrorAction SilentlyContinue
        $timeLine = $tail | Where-Object { $_ -match 'time=(\d{2}):(\d{2}):(\d{2})' } | Select-Object -Last 1
        if ($timeLine -and $timeLine -match 'time=(\d{2}):(\d{2}):(\d{2})') {
            Write-Host ('    merge progress: {0}:{1}:{2}' -f $Matches[1], $Matches[2], $Matches[3]) -ForegroundColor DarkGray -NoNewline
            Write-Host "`r" -NoNewline
        }
    }
}
Write-Host ('{0}' -f (' ' * 60)) -NoNewline
Write-Host "`r" -NoNewline

if ($proc.ExitCode -ne 0) {
    Write-Host ''
    Write-Host ('Concat FAILED, exit code {0}' -f $proc.ExitCode) -ForegroundColor Red
    if (Test-Path $stderrLog) {
        Get-Content $stderrLog -Tail 30
    }
    exit 1
}

# ===== Step 4: Cleanup TS intermediates =====
Write-Host '[3/3] Cleaning up TS intermediates...' -ForegroundColor Yellow
foreach ($ts in $tsFiles) {
    if (Test-Path $ts) { Remove-Item $ts -Force }
}
Remove-Item $FILELIST_TXT -Force -ErrorAction SilentlyContinue

# ===== Done =====
Write-Host ''
Write-Host '=== DONE ===' -ForegroundColor Cyan
Write-Host ('Output : {0}' -f $FINAL_MP4) -ForegroundColor Green

if (Test-Path $FINAL_MP4) {
    $outGB = [math]::Round((Get-Item $FINAL_MP4).Length / 1GB, 2)
    $dur   = (& ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 $FINAL_MP4 2>$null) -as [double]
    $h     = [math]::Floor($dur / 3600)
    $m     = [math]::Floor(($dur % 3600) / 60)
    $s     = [math]::Floor($dur % 60)
    Write-Host ('Size  : {0} GB' -f $outGB)    -ForegroundColor Green
    Write-Host ('Length: {0:D2}:{1:D2}:{2:D2}' -f $h, $m, $s) -ForegroundColor Green
}

Remove-Item $stdoutLog, $stderrLog -ErrorAction SilentlyContinue
Write-Host ''
