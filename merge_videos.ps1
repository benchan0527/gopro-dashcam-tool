# Fast GoPro Video Merger
$SOURCE_DIR = "N:\20250712_SZChina"
$OUTPUT_DIR = "c:\gopro addgps\merged"

$videos = @(
    "GX010004.MP4",
    "GX010005.MP4",
    "GX010006.MP4",
    "GX010007.MP4",
    "GX010008.MP4",
    "GX010009.MP4",
    "GX010010.MP4",
    "GX010011.MP4",
    "GX020006.MP4",
    "GX020007.MP4",
    "GX020008.MP4",
    "GX030007.MP4",
    "GX040007.MP4",
    "GX050007.MP4"
)

Write-Host "=== GoPro Video Merger ===" -ForegroundColor Cyan
Write-Host "Total videos: $($videos.Count)"
Write-Host ""

Write-Host "[1/3] Converting videos to TS format..." -ForegroundColor Yellow

$tsFiles = @()
for ($i = 0; $i -lt $videos.Count; $i++) {
    $v = $videos[$i]
    $tsFile = "$OUTPUT_DIR\part$($i+1).ts"
    $tsFiles += $tsFile
    
    if (Test-Path $tsFile) {
        Write-Host "  Skip: $v (already converted)" -ForegroundColor Gray
        continue
    }
    
    $inputPath = "$SOURCE_DIR\$v"
    Write-Host "  Converting: $v" -ForegroundColor Green
    
    & ffmpeg -y -i $inputPath -c copy -map 0:v:0 -map 0:a:0 -f mpegts $tsFile 2>$null
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Error converting $v" -ForegroundColor Red
    }
}

Write-Host "[2/3] Merging TS files..." -ForegroundColor Yellow
$filelist = "$OUTPUT_DIR\filelist_ts.txt"
$content = ""
foreach ($ts in $tsFiles) {
    $tsEscaped = $ts -replace '\\', '/'
    $content += "file ""$tsEscaped""" + "`n"
}
Set-Content -Path $filelist -Value $content -Encoding UTF8

$outputMp4 = "$OUTPUT_DIR\merged_final.mp4"
Write-Host "  Starting merge..." -ForegroundColor Green
& ffmpeg -y -f concat -safe 0 -i $filelist -c copy $outputMp4 2>&1 | ForEach-Object {
    if ($_ -match "time=(\d{2}):(\d{2}):(\d{2})") {
        $time = "$($Matches[1]):$($Matches[2]):$($Matches[3])"
        Write-Host "  Progress: $time" -ForegroundColor Gray -NoNewline
        Write-Host "`r" -NoNewline
    }
}

Write-Host ""
Write-Host "[3/3] Adding subtitles..." -ForegroundColor Yellow
$srtFile = "$OUTPUT_DIR\merged.srt"
$finalOutput = "$OUTPUT_DIR\final_with_subs.mp4"

if (Test-Path $srtFile) {
    & ffmpeg -y -i $outputMp4 -i $srtFile -c copy -c:s mov_text -disposition:s:0 default $finalOutput 2>$null
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Subtitles added!" -ForegroundColor Green
    } else {
        Write-Host "  Subtitle failed" -ForegroundColor Red
        $finalOutput = $outputMp4
    }
} else {
    Write-Host "  SRT not found, skipping" -ForegroundColor Yellow
    $finalOutput = $outputMp4
}

Write-Host "Cleaning up temp files..." -ForegroundColor Gray
foreach ($ts in $tsFiles) {
    if (Test-Path $ts) { Remove-Item $ts -Force }
}
Remove-Item $filelist -Force -ErrorAction SilentlyContinue

$size = (Get-Item $finalOutput).Length / 1GB
Write-Host ""
Write-Host "=== DONE! ===" -ForegroundColor Cyan
Write-Host "Output: $finalOutput" -ForegroundColor Green
Write-Host "Size: $([math]::Round($size, 2)) GB" -ForegroundColor Green
