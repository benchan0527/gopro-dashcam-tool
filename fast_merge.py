# Fast GoPro Video Merger
# 合併 14 條片 + 字幕

import subprocess
import os
import time

SOURCE_DIR = r'N:\20250712_SZChina'
OUTPUT_DIR = r'c:\gopro addgps\merged'

# 14 條片 (已經按時間排序)
videos = [
    'GX010004.MP4',
    'GX010005.MP4',
    'GX010006.MP4',
    'GX010007.MP4',
    'GX010008.MP4',
    'GX010009.MP4',
    'GX010010.MP4',
    'GX010011.MP4',
    'GX020006.MP4',
    'GX020007.MP4',
    'GX020008.MP4',
    'GX030007.MP4',
    'GX040007.MP4',
    'GX050007.MP4',
]

srt_file = os.path.join(OUTPUT_DIR, 'merged.srt')

print(f'=== 合併 {len(videos)} 條片 ===')
print(f'輸出: {OUTPUT_DIR}\\merged_final.mp4')
print(f'字幕: {srt_file}')
print(f'預計時間: 5-10 分鐘')
print()

# Step 1: Create filelist for concat
filelist = os.path.join(OUTPUT_DIR, 'filelist_fast.txt')
with open(filelist, 'w') as f:
    for v in videos:
        path = os.path.join(SOURCE_DIR, v).replace('\\', '/')
        f.write(f'file {path}\n')

print(f'[1/3] Filelist created: {len(videos)} files')

# Step 2: Merge videos using FFmpeg concat (fast copy mode)
output_mp4 = os.path.join(OUTPUT_DIR, 'merged_final.mp4')

# Use -c copy for fastest merge (just copy streams, no re-encoding)
cmd = [
    'ffmpeg', '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', filelist,
    '-c', 'copy',
    '-fflags', '+genpts',
    output_mp4
]

print('[2/3] Merging videos (fast copy mode)...')
start = time.time()
result = subprocess.run(cmd, capture_output=True, text=True)

if result.returncode != 0:
    print('Error:', result.stderr[:500])
    # Try alternative method with re-encoding
    print('Trying with re-encoding...')
    cmd = [
        'ffmpeg', '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', filelist,
        '-c:v', 'h264_nvenc',
        '-preset', 'fast',
        '-cq', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        output_mp4
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)

elapsed = time.time() - start
print(f'    完成! 耗时: {elapsed:.1f}秒')

# Step 3: Add subtitles
final_output = os.path.join(OUTPUT_DIR, 'final_with_subs.mp4')

if os.path.exists(srt_file):
    print('[3/3] Adding subtitles...')
    cmd = [
        'ffmpeg', '-y',
        '-i', output_mp4,
        '-i', srt_file,
        '-c', 'copy',
        '-c:s', 'mov_text',
        '-disposition:s:0', 'default',
        final_output
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.returncode == 0:
        print(f'    完成!')
        print(f'\n=== 完成! ===')
        print(f'輸出: {final_output}')
    else:
        print('Subtitle error:', result.stderr[:300])
        final_output = output_mp4
else:
    print('[3/3] SRT not found, skipping subtitles')
    final_output = output_mp4

print(f'\n最終輸出: {final_output}')
print(f'檔案大小: {os.path.getsize(final_output) / 1024 / 1024:.1f} MB')

input('\n按 Enter 退出...')
