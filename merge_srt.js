/**
 * Merge GoPro SRT files with adjusted timestamps
 * 
 * This script:
 * 1. Reads all SRT files from output folder
 * 2. Gets video duration for each file
 * 3. Adjusts timestamps to be continuous (absolute time)
 * 4. Merges all into one SRT file
 * 5. Optionally merges the video files too
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCE_DIR = 'N:\\20250712_SZChina';
const OUTPUT_DIR = path.join(__dirname, 'output');
const MERGED_DIR = path.join(__dirname, 'merged');

// Get all SRT files sorted by name (which should be chronological)
function getSrtFiles() {
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('GX') && f.endsWith('.srt'))
    .sort();
  
  return files.map(f => {
    const baseName = f.replace('.srt', '');
    return {
      name: baseName,
      srtPath: path.join(OUTPUT_DIR, f),
      // Try source directory for videos
      mp4Path: path.join(SOURCE_DIR, `${baseName}.MP4`),
      lrvPath: path.join(SOURCE_DIR, `${baseName}.LRV`)
    };
  });
}

// Parse SRT file and return all subtitle entries
function parseSrt(srtPath) {
  const content = fs.readFileSync(srtPath, 'utf-8');
  const entries = [];
  
  // Split by double newlines
  const blocks = content.trim().split(/\n\n+/);
  
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    
    const index = parseInt(lines[0]);
    const timeLine = lines[1];
    const textLines = lines.slice(2);
    
    // Parse timestamp: "00:00:00,000 --> 00:00:01,000"
    const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!timeMatch) continue;
    
    const startTime = (
      parseInt(timeMatch[1]) * 3600000 +
      parseInt(timeMatch[2]) * 60000 +
      parseInt(timeMatch[3]) * 1000 +
      parseInt(timeMatch[4])
    );
    
    const endTime = (
      parseInt(timeMatch[5]) * 3600000 +
      parseInt(timeMatch[6]) * 60000 +
      parseInt(timeMatch[7]) * 1000 +
      parseInt(timeMatch[8])
    );
    
    entries.push({
      index,
      startTime,
      endTime,
      text: textLines.join('\n')
    });
  }
  
  return entries;
}

// Convert milliseconds to SRT timestamp format
function formatSrtTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
}

// Get video duration using FFprobe
function getVideoDuration(videoPath) {
  if (!fs.existsSync(videoPath)) {
    console.warn(`  Video not found: ${videoPath}`);
    return 0;
  }
  
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    const duration = parseFloat(output.trim());
    console.log(`  Duration: ${duration.toFixed(1)}s (${formatSrtTime(duration * 1000)})`);
    return duration * 1000; // Convert to milliseconds
  } catch (err) {
    console.warn(`  Could not get duration: ${err.message}`);
    return 0;
  }
}

// Merge SRT files with adjusted timestamps
function mergeSrtFiles(srtFiles) {
  console.log('\n=== Merging SRT files ===');
  
  let cumulativeOffset = 0;
  let allEntries = [];
  let globalIndex = 1;
  
  for (const file of srtFiles) {
    console.log(`\nProcessing: ${file.name}`);
    
    if (!fs.existsSync(file.srtPath)) {
      console.log(`  SRT not found, skipping`);
      continue;
    }
    
    // Get video duration for offset calculation
    const videoDuration = getVideoDuration(file.mp4Path);
    const lrvDuration = getVideoDuration(file.lrvPath);
    
    // Use the longer duration
    const duration = Math.max(videoDuration, lrvDuration);
    
    if (duration === 0) {
      // Try to get duration from SRT itself
      const entries = parseSrt(file.srtPath);
      if (entries.length > 0) {
        const lastEntry = entries[entries.length - 1];
        const calculatedDuration = lastEntry.endTime;
        console.log(`  Using SRT duration: ${formatSrtTime(calculatedDuration)}`);
        cumulativeOffset += calculatedDuration;
      }
    } else {
      cumulativeOffset += duration;
    }
    
    // Parse and adjust timestamps
    const entries = parseSrt(file.srtPath);
    
    for (const entry of entries) {
      allEntries.push({
        index: globalIndex++,
        startTime: entry.startTime, // Already in relative time from video start
        endTime: entry.endTime,
        text: entry.text,
        originalFile: file.name
      });
    }
    
    console.log(`  Added ${entries.length} entries, cumulative offset: ${formatSrtTime(cumulativeOffset)}`);
  }
  
  // Now we need to add the offset to each entry based on when it appears
  // The entries are already in order, but we need to calculate the offset
  // based on cumulative duration of previous videos
  
  // Actually, the current approach adds cumulativeOffset at the END
  // We need to recalculate properly
  
  console.log('\n=== Recalculating timestamps ===');
  
  // Reset and do it properly
  cumulativeOffset = 0;
  globalIndex = 1;
  const adjustedEntries = [];
  
  for (const file of srtFiles) {
    if (!fs.existsSync(file.srtPath)) continue;
    
    const entries = parseSrt(file.srtPath);
    const fileDuration = entries.length > 0 ? entries[entries.length - 1].endTime : 0;
    
    for (const entry of entries) {
      adjustedEntries.push({
        index: globalIndex++,
        startTime: entry.startTime + cumulativeOffset,
        endTime: entry.endTime + cumulativeOffset,
        text: entry.text
      });
    }
    
    console.log(`${file.name}: offset ${formatSrtTime(cumulativeOffset)}, duration ${formatSrtTime(fileDuration)}`);
    cumulativeOffset += fileDuration;
  }
  
  // Generate merged SRT content
  let srtContent = '';
  for (const entry of adjustedEntries) {
    srtContent += `${entry.index}\n`;
    srtContent += `${formatSrtTime(entry.startTime)} --> ${formatSrtTime(entry.endTime)}\n`;
    srtContent += `${entry.text}\n\n`;
  }
  
  return { srtContent, totalDuration: cumulativeOffset };
}

// Merge video files
function mergeVideos(srtFiles) {
  console.log('\n=== Merging video files ===');
  
  if (!fs.existsSync(MERGED_DIR)) {
    fs.mkdirSync(MERGED_DIR, { recursive: true });
  }
  
  // Find available video files in source directory
  const videoFiles = [];
  for (const file of srtFiles) {
    if (fs.existsSync(file.mp4Path)) {
      videoFiles.push(file.mp4Path);
      console.log(`  Found: ${path.basename(file.mp4Path)}`);
    } else if (fs.existsSync(file.lrvPath)) {
      videoFiles.push(file.lrvPath);
      console.log(`  Found: ${path.basename(file.lrvPath)} (LRV)`);
    } else {
      console.log(`  Not found: ${file.name}`);
    }
  }
  
  if (videoFiles.length === 0) {
    console.log('No video files found to merge');
    return null;
  }
  
  // Create filelist for FFmpeg
  const filelistPath = path.join(MERGED_DIR, 'filelist.txt');
  let listContent = '';
  for (const vfile of videoFiles) {
    // No quotes needed when not using shell: true
    listContent += `file ${vfile.replace(/\\/g, '/')}\n`;
  }
  fs.writeFileSync(filelistPath, listContent);
  console.log(`\nCreated filelist with ${videoFiles.length} files`);
  
  // Merge videos using concat demuxer with re-encoding
  // This handles GoPro files with inconsistent streams better
  const outputPath = path.join(MERGED_DIR, 'merged.mp4');
  console.log('Merging with FFmpeg (re-encoding)...');
  console.log('預計時間: 5-15 分鐘 (取決於電腦速度)');
  
  try {
    // Use concat filter with re-encoding to handle GoPro streams
    execSync(`ffmpeg -y -f concat -safe 0 -i "${filelistPath}" -c:v h264_nvenc -preset fast -cq 23 -c:a aac -b:a 192k "${outputPath}"`, {
      stdio: 'inherit'
    });
    console.log(`✓ Merged video: ${outputPath}`);
    return outputPath;
  } catch (err) {
    console.error(`Merge failed: ${err.message}`);
    return null;
  }
}

// Main execution
console.log('=== GoPro SRT Merger ===\n');

const srtFiles = getSrtFiles();
console.log(`Found ${srtFiles.length} SRT files:`);
srtFiles.forEach((f, i) => console.log(`  ${i+1}. ${f.name}`));

// Merge SRT
const { srtContent, totalDuration } = mergeSrtFiles(srtFiles);

// Save merged SRT
const mergedSrtPath = path.join(MERGED_DIR, 'merged.srt');
fs.writeFileSync(mergedSrtPath, srtContent);
console.log(`\n✓ Saved merged SRT: ${mergedSrtPath}`);
console.log(`  Total duration: ${formatSrtTime(totalDuration)}`);
console.log(`  Total entries: ${srtContent.split('\n\n').filter(s => s.trim()).length}`);

// Optionally merge videos
console.log('\n=== Option: Merge videos? ===');
console.log('Run: node merge_srt.js --videos');
console.log('to also merge the video files.\n');

// Check if --videos flag is provided
if (process.argv.includes('--videos') || process.argv.includes('-v')) {
  const mergedVideo = mergeVideos(srtFiles);
  
  if (mergedVideo) {
    // Add subtitle to merged video
    console.log('\n=== Adding subtitles to merged video ===');
    const subbedPath = path.join(MERGED_DIR, 'merged_subs.mp4');
    
    try {
      execSync(`ffmpeg -y -i "${mergedVideo}" -i "${mergedSrtPath}" -c copy -c:s mov_text -disposition:s:0 default "${subbedPath}"`, {
        stdio: 'inherit'
      });
      console.log(`✓ Saved: ${subbedPath}`);
    } catch (err) {
      console.error(`Subtitle failed: ${err.message}`);
    }
  }
}

console.log('\n=== Done! ===');
