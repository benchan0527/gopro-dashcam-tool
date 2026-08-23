const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { processPair } = require('../extract.js');
const { spawn, exec } = require('child_process');

let mainWindow;
let activeMerger = null; // { proc, cancelled }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
    },
    title: 'GoPro Telemetry & Video Merger'
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open DevTools for debugging
  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'GoPro Videos', extensions: ['MP4', 'LRV', 'mp4', 'lrv'] }
    ]
  });
  
  if (result.canceled) {
    return { canceled: true, files: [] };
  }
  
  return { canceled: false, files: result.filePaths };
});

ipcMain.handle('process-files', async (event, filePaths) => {
  const results = [];
  let nominatimWasRunning = false;
  
  // Start Nominatim before processing if not running
  // Only try once, don't keep checking
  try {
    nominatimWasRunning = await isNominatimRunning();
    if (!nominatimWasRunning) {
      mainWindow.webContents.send('progress', {
        current: 0,
        total: filePaths.length,
        file: 'Starting Nominatim...',
        status: 'processing'
      });
      await ensureNominatimRunning();
    }
  } catch (error) {
    console.error('Failed to start Nominatim:', error);
    // Continue without Nominatim - GPS will be skipped
    mainWindow.webContents.send('progress', {
      current: 0,
      total: filePaths.length,
      file: 'Nominatim not available, skipping GPS...',
      status: 'processing'
    });
  }
  
  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const fileName = path.basename(filePath);
    
    mainWindow.webContents.send('progress', {
      current: i + 1,
      total: filePaths.length,
      file: fileName,
      status: 'processing'
    });
    
    try {
      let pair;
      
      if (filePath.toLowerCase().endsWith('.mp4')) {
        const baseName = path.basename(filePath, path.extname(filePath));
        const dir = path.dirname(filePath);
        const lrvPath = path.join(dir, baseName.replace('GX', 'GL') + '.LRV');
        const lrvExists = fs.existsSync(lrvPath);
        
        pair = {
          baseName: baseName,
          mp4: filePath,
          lrv: lrvExists ? lrvPath : null
        };
      } else {
        const baseName = path.basename(filePath, path.extname(filePath)).replace('GL', 'GX');
        const dir = path.dirname(filePath);
        const mp4Path = path.join(dir, baseName + '.MP4');
        
        pair = {
          baseName: baseName,
          mp4: fs.existsSync(mp4Path) ? mp4Path : null,
          lrv: filePath
        };
      }
      
      if (!pair.mp4 && !pair.lrv) {
        results.push({
          success: false,
          file: fileName,
          error: 'No valid MP4 or LRV file found'
        });
        continue;
      }
      
      const result = await processPair(pair);
      
      if (result.success) {
        const srtContent = fs.readFileSync(result.outputFile, 'utf8');
        results.push({
          success: true,
          file: fileName,
          outputFile: result.outputFile,
          srtContent: srtContent,
          preview: srtContent.substring(0, 500)
        });
      } else {
        results.push({
          success: false,
          file: fileName,
          error: result.error
        });
      }
    } catch (error) {
      results.push({
        success: false,
        file: fileName,
        error: error.message
      });
    }
    
    mainWindow.webContents.send('progress', {
      current: i + 1,
      total: filePaths.length,
      file: fileName,
      status: 'completed'
    });
  }
  
  // Stop Nominatim if it was not running before
  if (!nominatimWasRunning) {
    try {
      await runCommand('docker stop nominatim-web nominatim-db');
      console.log('Nominatim stopped');
    } catch (error) {
      console.error('Failed to stop Nominatim:', error);
    }
  }
  
  return results;
});

ipcMain.handle('save-srt', async (event, srtContent, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: 'SRT Subtitle', extensions: ['srt'] }
    ]
  });
  
  if (result.canceled) {
    return { canceled: true };
  }
  
  try {
    fs.writeFileSync(result.filePath, srtContent, 'utf8');
    return { canceled: false, filePath: result.filePath };
  } catch (error) {
    return { canceled: false, error: error.message };
  }
});

ipcMain.handle('get-output-dir', () => {
  return path.join(__dirname, '..', 'output');
});

// Helper function to get video creation date
async function getVideoCreationDate(filePath) {
  return new Promise((resolve) => {
    // Use ffprobe to get video creation time
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath
    ];
    
    const ffprobe = spawn('ffprobe', args);
    let output = '';
    
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(output);
          // Try to get creation_time from format
          if (info.format && info.format.tags && info.format.tags.creation_time) {
            resolve(new Date(info.format.tags.creation_time));
            return;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      // Fallback: use file modification time
      const stats = fs.statSync(filePath);
      resolve(stats.mtime);
    });
    
    ffprobe.on('error', () => {
      // Fallback: use file modification time
      const stats = fs.statSync(filePath);
      resolve(stats.mtime);
    });
  });
}

// Helper function to sort videos by date (earliest first)
async function sortVideosByDate(filePaths) {
  const filesWithDates = [];

  for (const filePath of filePaths) {
    const [date, stats] = await Promise.all([
      getVideoCreationDate(filePath),
      new Promise((resolve) => fs.stat(filePath, (err, s) => resolve(err ? null : s)))
    ]);
    const probe = await ffprobeJson(filePath);
    const vStream = (probe && probe.streams || []).find((s) => s.codec_type === 'video') || {};
    const aStream = (probe && probe.streams || []).find((s) => s.codec_type === 'audio') || {};
    filesWithDates.push({
      name: path.basename(filePath),
      path: filePath,
      size: stats ? stats.size : 0,
      mtime: stats ? stats.mtimeMs : 0,
      date: date,
      duration: probe && probe.format ? parseFloat(probe.format.duration) || 0 : 0,
      codec: vStream.codec_name || '',
      width: vStream.width || 0,
      height: vStream.height || 0,
      audioCodec: aStream.codec_name || null
    });
  }

  // Sort by date (earliest first)
  filesWithDates.sort((a, b) => a.date - b.date);
  return filesWithDates;
}

// Parse SRT file and return all subtitle entries
function parseSrt(srtPath) {
  const content = fs.readFileSync(srtPath, 'utf-8');
  const entries = [];
  
  const blocks = content.trim().split(/\n\n+/);
  
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    
    const index = parseInt(lines[0]);
    const timeLine = lines[1];
    const textLines = lines.slice(2);
    
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

// Merge SRT files with adjusted timestamps
async function mergeSrtFiles(sortedFiles, sortedSrtFiles, outputPath) {
  console.log('\n=== Merging SRT files ===');
  
  let cumulativeOffset = 0;
  const adjustedEntries = [];
  let globalIndex = 1;
  
  for (let i = 0; i < sortedSrtFiles.length; i++) {
    const srtPath = sortedSrtFiles[i];
    const videoPath = sortedFiles[i];
    const baseName = path.basename(srtPath, '.srt');
    
    console.log(`Processing: ${baseName}`);
    
    if (!fs.existsSync(srtPath)) {
      console.log(`  SRT not found, skipping`);
      continue;
    }
    
    // Get video duration
    let fileDuration = 0;
    try {
      const { execSync } = require('child_process');
      const output = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      fileDuration = parseFloat(output.trim()) * 1000;
      console.log(`  Duration: ${(fileDuration / 1000).toFixed(1)}s`);
    } catch (err) {
      console.log(`  Could not get duration, using SRT duration`);
    }
    
    // Parse and adjust timestamps
    const entries = parseSrt(srtPath);
    
    if (fileDuration === 0 && entries.length > 0) {
      fileDuration = entries[entries.length - 1].endTime;
    }
    
    for (const entry of entries) {
      adjustedEntries.push({
        index: globalIndex++,
        startTime: entry.startTime + cumulativeOffset,
        endTime: entry.endTime + cumulativeOffset,
        text: entry.text
      });
    }
    
    cumulativeOffset += fileDuration;
  }
  
  // Generate merged SRT content
  let srtContent = '';
  for (const entry of adjustedEntries) {
    srtContent += `${entry.index}\n`;
    srtContent += `${formatSrtTime(entry.startTime)} --> ${formatSrtTime(entry.endTime)}\n`;
    srtContent += `${entry.text}\n\n`;
  }
  
  const mergedSrtPath = path.join(outputPath, 'merged.srt');
  fs.writeFileSync(mergedSrtPath, srtContent);
  console.log(`\n✓ Saved merged SRT: ${mergedSrtPath}`);
  console.log(`  Total duration: ${formatSrtTime(cumulativeOffset)}`);
  console.log(`  Total entries: ${adjustedEntries.length}`);
}

// IPC handler to select output directory
ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Output Directory'
  });
  
  if (result.canceled) {
    return { canceled: true, filePath: null };
  }
  
  return { canceled: false, filePath: result.filePaths[0] };
});

// IPC handler to merge videos
ipcMain.handle('merge-videos', async (event, options) => {
  const { files, outputDir, sortByDate, addSubtitles } = options;
  
  try {
    // Sort videos by date if requested
    let sortedFiles = files;
    if (sortByDate) {
      mainWindow.webContents.send('merge-progress', {
        stage: 'Sorting videos by date...',
        message: 'Reading video timestamps...'
      });
      sortedFiles = await sortVideosByDate(files);
    }
    
    const outputPath = outputDir || path.join(__dirname, '..', 'merged');
    
    // Ensure output directory exists
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }
    
    mainWindow.webContents.send('merge-progress', {
      progress: 10,
      stage: 'Creating filelist...',
      message: `Found ${sortedFiles.length} videos to merge`
    });
    
    // Create filelist for FFmpeg concat
    // Use relative paths for Windows compatibility (no quotes needed for relative paths without spaces)
    const filelistPath = path.join(outputPath, 'filelist.txt');
    const filelistContentRelative = sortedFiles
      .map(f => `file ${path.relative(outputPath, f).replace(/\\/g, '/')}`)
      .join('\n');
    fs.writeFileSync(filelistPath, filelistContentRelative, 'utf8');
    
    // Debug: Log the filelist content
    console.log('=== Filelist Content ===');
    console.log(filelistContentRelative);
    console.log('========================');
    
    mainWindow.webContents.send('merge-progress', {
      progress: 20,
      stage: 'Merging videos...',
      message: `Running FFmpeg merge (fast copy mode)...\nFiles: ${sortedFiles.length}`
    });

    const mergedPath = path.join(outputPath, 'merged_final.mp4');
    
    // Merge using FFmpeg concat with fast copy
    let ffmpegError = '';
    
    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', filelistPath,
        '-c', 'copy',
        '-fflags', '+genpts',
        mergedPath
      ];
      
      // Use PowerShell to handle paths with spaces correctly
      const psCommand = `ffmpeg -f concat -safe 0 -i "${filelistPath}" -c copy -fflags +genpts "${mergedPath}"`;
      console.log('=== PowerShell Command ===');
      console.log(psCommand);
      console.log('==========================');
      const ffmpeg = spawn('powershell', ['-Command', psCommand]);
      
      ffmpeg.stderr.on('data', (data) => {
        ffmpegError += data.toString();
        const output = data.toString();
        // Try to extract progress
        const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2})/);
        if (timeMatch) {
          mainWindow.webContents.send('merge-progress', {
            progress: 20 + Math.floor(Math.random() * 30), // Approximate progress
            stage: 'Merging videos...',
            message: `Processing: ${timeMatch[0]}`
          });
        }
      });
      
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Log full error for debugging
          console.error('FFmpeg error output:', ffmpegError);
          reject(new Error(ffmpegError.substring(0, 1000) || 'FFmpeg merge failed'));
        }
      });
      
      ffmpeg.on('error', (err) => {
        reject(err);
      });
    }).catch(async (error) => {
      // If copy mode fails, try with re-encoding
      mainWindow.webContents.send('merge-progress', {
        stage: 'Retrying with re-encoding...',
        message: 'Copy mode failed, trying with re-encoding'
      });
      
      await new Promise((resolve, reject) => {
        const args = [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', filelistPath,
          '-c:v', 'h264_nvenc',
          '-preset', 'fast',
          '-cq', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          mergedPath
        ];
        
        const ffmpeg = spawn('ffmpeg', args);
        
        ffmpeg.stderr.on('data', (data) => {
          ffmpegError = data.toString();
          const timeMatch = data.toString().match(/time=(\d{2}):(\d{2}):(\d{2})/);
          if (timeMatch) {
            mainWindow.webContents.send('merge-progress', {
              progress: 20 + Math.floor(Math.random() * 30),
              stage: 'Merging videos (re-encoding)...',
              message: `Processing: ${timeMatch[0]}`
            });
          }
        });
        
        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(ffmpegError.substring(0, 500) || 'FFmpeg merge failed'));
          }
        });
        
        ffmpeg.on('error', (err) => {
          reject(err);
        });
      });
    });

    // ====== MERGE SRT FILES ======
    const sortedSrtFiles = sortedFiles.map(f => {
      const baseName = path.basename(f, path.extname(f));
      const dir = path.dirname(f);
      return path.join(dir, baseName + '.srt');
    }).filter(f => fs.existsSync(f));

    if (sortedSrtFiles.length > 0) {
      mainWindow.webContents.send('merge-progress', {
        progress: 55,
        stage: 'Merging SRT subtitles...',
        message: `Found ${sortedSrtFiles.length} SRT files to merge`
      });

      await mergeSrtFiles(sortedFiles, sortedSrtFiles, outputPath);
    }

    mainWindow.webContents.send('merge-progress', {
      progress: 60,
      stage: 'Checking for subtitles...',
      message: 'Looking for SRT file...'
    });
    
    let finalPath = mergedPath;
    
    // Add subtitles if requested
    if (addSubtitles) {
      const srtPath = path.join(outputPath, 'merged.srt');
      
      if (fs.existsSync(srtPath)) {
        mainWindow.webContents.send('merge-progress', {
          progress: 70,
          stage: 'Adding subtitles...',
          message: 'Merging SRT subtitles...'
        });
        
        finalPath = path.join(outputPath, 'final_with_subs.mp4');
        
        await new Promise((resolve, reject) => {
          const args = [
            '-y',
            '-i', mergedPath,
            '-i', srtPath,
            '-c', 'copy',
            '-c:s', 'mov_text',
            '-disposition:s:0', 'default',
            finalPath
          ];
          
          const ffmpeg = spawn('ffmpeg', args);
          
          ffmpeg.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              // Fallback to original if subtitle fails
              finalPath = mergedPath;
              resolve();
            }
          });
          
          ffmpeg.on('error', () => {
            finalPath = mergedPath;
            resolve();
          });
        });
        
        mainWindow.webContents.send('merge-progress', {
          progress: 100,
          stage: 'Complete!',
          message: 'Subtitles added successfully'
        });
      } else {
        mainWindow.webContents.send('merge-progress', {
          progress: 100,
          stage: 'Complete!',
          message: 'SRT not found, skipping subtitles'
        });
      }
    } else {
      mainWindow.webContents.send('merge-progress', {
        progress: 100,
        stage: 'Complete!',
        message: 'Merge finished'
      });
    }
    
    // Clean up filelist
    try {
      fs.unlinkSync(filelistPath);
    } catch (e) {}
    
    // Get file size
    const stats = fs.statSync(finalPath);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
    
    return {
      success: true,
      outputPath: finalPath,
      fileSize: `${fileSizeMB} MB`
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

// IPC handler to sort files by video date (using FFprobe)
ipcMain.handle('sort-files-by-date', async (event, filePaths) => {
  try {
    const sortedFiles = await sortVideosByDate(filePaths);
    return { success: true, files: sortedFiles };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Helper to run shell commands with timeout
function runCommand(command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    exec(command, { shell: 'cmd.exe' }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// Check if Docker is available and running
async function isDockerAvailable() {
  try {
    const { stdout, stderr } = await runCommand('docker info');
    return stdout.length > 0 || stderr.length > 0;
  } catch (error) {
    return false;
  }
}

// Check if Nominatim is running
async function isNominatimRunning() {
  try {
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      return false;
    }
    const { stdout } = await runCommand('docker ps --filter "name=nominatim-web" --format "{{.Names}}"');
    if (!stdout.trim().includes('nominatim-web')) {
      return false;
    }
    
    // Also verify the API is responding
    const http = require('http');
    await new Promise((resolve, reject) => {
      const req = http.get('http://localhost:8080/status.php', { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`Status ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
    
    return true;
  } catch (error) {
    console.log('[isNominatimRunning] Check failed:', error.message);
    return false;
  }
}

// Ensure Nominatim is running
async function ensureNominatimRunning() {
  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    throw new Error('Docker is not running. Please start Docker Desktop.');
  }
  
  const running = await isNominatimRunning();
  if (!running) {
    // Check if containers exist but are stopped
    const { stdout: psOutput } = await runCommand('docker ps -a --filter "name=nominatim" --format "{{.Names}}"');
    
    if (psOutput.includes('nominatim-db')) {
      // Start existing containers
      await runCommand('docker start nominatim-db');
      await runCommand('docker start nominatim-web');
    } else {
      // Create and start new containers
      await runCommand('docker run -d --name nominatim-db -v nominatim-data:/data stefanreuter/nominatim:latest /app/startpostgres.sh');
      await runCommand('docker run -d --name nominatim-web --link nominatim-db:db -p 8080:8080 -v nominatim-data:/data stefanreuter/nominatim:latest /app/start.sh');
    }
    
    // Wait for Nominatim to be ready (can take 30-60 seconds)
    const maxWait = 90;
    const checkInterval = 5;
    let waited = 0;
    
    while (waited < maxWait) {
      await new Promise(resolve => setTimeout(resolve, checkInterval * 1000));
      waited += checkInterval;
      
      try {
        const http = require('http');
        await new Promise((resolve, reject) => {
          const req = http.get('http://localhost:8080/status.php', { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              if (res.statusCode === 200) resolve(data);
              else reject(new Error(`Status ${res.statusCode}`));
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
        console.log('[Nominatim] Ready after ' + waited + 's');
        return true;
      } catch (e) {
        console.log('[Nominatim] Waiting... (' + waited + 's/' + maxWait + 's)');
      }
    }
    
    throw new Error('Nominatim took too long to start. Please try again or check logs.');
  }
  
  // Even if running, verify the API is responding
  try {
    const http = require('http');
    await new Promise((resolve, reject) => {
      const req = http.get('http://localhost:8080/status.php', { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`Status ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  } catch (e) {
    throw new Error('Nominatim container is running but API is not responding. Try stopping and starting again.');
  }
  
  return true;
}

// Check Nominatim status
ipcMain.handle('check-nominatim', async () => {
  try {
    // First check if Docker is available
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      return { running: false, message: 'Docker is not running or not installed' };
    }
    
    // Check if nominatim-web container is running
    const { stdout } = await runCommand('docker ps --filter "name=nominatim-web" --format "{{.Names}}"');
    const isRunning = stdout.trim().includes('nominatim-web');
    
    if (isRunning) {
      // Try to connect to the API
      try {
        const http = require('http');
        await new Promise((resolve, reject) => {
          const req = http.get('http://localhost:8080/status.php', { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
        return { running: true, message: 'Nominatim is running and ready' };
      } catch (e) {
        // Check container logs for errors
        try {
          const { stdout: logs } = await runCommand('docker logs nominatim-web --tail 20');
          if (logs.includes('address already in use') || logs.includes('Port 8080')) {
            return { running: false, message: 'Port 8080 is in use. Stop other services using this port.' };
          }
          if (logs.includes('database') && logs.includes('error')) {
            return { running: false, message: 'Database error in container. Try restarting Docker.' };
          }
        } catch (logErr) {}
        
        return { running: false, message: 'Container running but API not responding. May still be initializing...' };
      }
    } else {
      return { running: false, message: 'Nominatim is not running' };
    }
  } catch (error) {
    return { running: false, message: `Error: ${error.message}` };
  }
});

// Start Nominatim
ipcMain.handle('start-nominatim', async () => {
  try {
    // First check if Docker is available
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      return { success: false, message: 'Docker is not running. Please start Docker Desktop.' };
    }
    
    // Check if containers already exist
    const { stdout: psOutput } = await runCommand('docker ps -a --filter "name=nominatim" --format "{{.Names}}"');
    
    let started = false;
    if (psOutput.includes('nominatim-db')) {
      // Start existing containers
      await runCommand('docker start nominatim-db');
      await runCommand('docker start nominatim-web');
      started = true;
    } else {
      // Create and start new containers
      await runCommand('docker run -d --name nominatim-db -v nominatim-data:/data stefanreuter/nominatim:latest /app/startpostgres.sh');
      await runCommand('docker run -d --name nominatim-web --link nominatim-db:db -p 8080:8080 -v nominatim-data:/data stefanreuter/nominatim:latest /app/start.sh');
      started = true;
    }
    
    if (started) {
      // Wait for Nominatim to initialize (can take 30-60 seconds)
      mainWindow?.webContents?.send('merge-progress', { message: 'Waiting for Nominatim to initialize...' });
      
      const maxWait = 90; // seconds
      const checkInterval = 5; // seconds
      let waited = 0;
      
      while (waited < maxWait) {
        await new Promise(resolve => setTimeout(resolve, checkInterval * 1000));
        waited += checkInterval;
        
        try {
          const http = require('http');
          await new Promise((resolve, reject) => {
            const req = http.get('http://localhost:8080/status.php', { timeout: 5000 }, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => {
                if (res.statusCode === 200) resolve(data);
                else reject(new Error(`Status ${res.statusCode}`));
              });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
          });
          return { success: true, message: 'Nominatim is ready!' };
        } catch (e) {
          mainWindow?.webContents?.send('merge-progress', { message: `Waiting for Nominatim... (${waited}s/${maxWait}s)` });
        }
      }
      
      return { success: true, message: 'Started but may need more time to initialize. Click Check again in a moment.' };
    }
    
    return { success: false, message: 'Failed to start Nominatim containers' };
  } catch (error) {
    return { success: false, message: `Error: ${error.message}` };
  }
});

// Stop Nominatim
ipcMain.handle('stop-nominatim', async () => {
  try {
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      return { success: false, message: 'Docker is not running.' };
    }
    await runCommand('docker stop nominatim-web nominatim-db');
    return { success: true, message: 'Stopped Nominatim containers' };
  } catch (error) {
    return { success: false, message: `Error: ${error.message}` };
  }
});

// Get Nominatim container logs
ipcMain.handle('get-nominatim-logs', async () => {
  try {
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      return { success: false, message: 'Docker is not running.' };
    }
    
    // Get web container logs
    const { stdout: webLogs } = await runCommand('docker logs nominatim-web --tail 50 2>&1', 10000);
    
    return { success: true, logs: webLogs };
  } catch (error) {
    return { success: false, message: `Error: ${error.message}` };
  }
});

// ============================================================
// Dashcam Merger — IPC handlers
// ============================================================

const VIDEO_EXTS = new Set(['.mp4', '.MP4']);

function isVideoFile(name) {
  const ext = path.extname(name);
  return VIDEO_EXTS.has(ext);
}

function ffprobeJson(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      try { resolve(JSON.parse(out)); } catch (e) { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

ipcMain.handle('dashcam:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select folder with dashcam videos'
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, folder: result.filePaths[0] };
});

ipcMain.handle('dashcam:pick-output', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select output folder'
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, folder: result.filePaths[0] };
});

ipcMain.handle('dashcam:scan-folder', async (event, folder) => {
  try {
    if (!folder || !fs.existsSync(folder)) {
      return { success: false, error: 'Folder does not exist' };
    }
    const entries = fs.readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isFile() && isVideoFile(d.name));

    const files = entries.map((d) => {
      const full = path.join(folder, d.name);
      const stats = fs.statSync(full);
      return {
        name: d.name,
        path: full,
        size: stats.size,
        mtime: stats.mtimeMs
      };
    });

    return { success: true, folder, count: files.length, files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dashcam:probe', async (event, filePath) => {
  const info = await ffprobeJson(filePath);
  if (!info) return { success: false };
  const vStream = (info.streams || []).find((s) => s.codec_type === 'video') || {};
  const aStream = (info.streams || []).find((s) => s.codec_type === 'audio') || {};
  return {
    success: true,
    codec: vStream.codec_name || null,
    width: vStream.width || null,
    height: vStream.height || null,
    fps: vStream.r_frame_rate || null,
    duration: info.format ? parseFloat(info.format.duration) || 0 : 0,
    audioCodec: aStream.codec_name || null,
    creationTime: info.format && info.format.tags ? info.format.tags.creation_time || null : null,
    bitRate: info.format ? parseInt(info.format.bit_rate) || 0 : 0
  };
});

// ===== Resume detection =====
ipcMain.handle('dashcam:detect-resume', async (event, { outputDir, outputName }) => {
  try {
    if (!outputDir || !fs.existsSync(outputDir)) return null;

    // Look for filelist_*.txt in outputDir
    const entries = fs.readdirSync(outputDir);
    const filelists = entries
      .filter((f) => /^filelist_.+\.txt$/.test(f))
      .map((f) => {
        const fp = path.join(outputDir, f);
        const stat = fs.statSync(fp);
        return { path: fp, name: f, mtime: stat.mtime, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (filelists.length === 0) return null;

    const newest = filelists[0];
    const content = fs.readFileSync(newest.path, 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

    // Parse `file 'F:/temp/part0001.ts'` lines
    const tsRegex = /^file\s+'(.+)'$/;
    const tsFiles = [];
    for (const line of lines) {
      const m = line.match(tsRegex);
      if (!m) continue;
      // Normalize: in filelist we used forward slashes
      let ts = m[1].replace(/\//g, path.sep);
      if (!path.isAbsolute(ts)) ts = path.join(outputDir, ts);
      tsFiles.push(ts);
    }
    if (tsFiles.length === 0) return null;

    // Compute tsBytes + verify each file exists with content
    let tsBytes = 0;
    let presentCount = 0;
    const missing = [];
    for (const ts of tsFiles) {
      try {
        const s = fs.statSync(ts);
        if (s.size > 0) {
          tsBytes += s.size;
          presentCount++;
        } else {
          missing.push(ts);
        }
      } catch (e) {
        missing.push(ts);
      }
    }

    if (presentCount === 0) return null;

    // Derive original finalName from filelist timestamp
    // e.g. filelist_2026-08-22T15-49-53.txt → finalName = dashcam_merged_2026-08-22T15-49-53
    const stampMatch = newest.name.match(/^filelist_(.+)\.txt$/);
    const stamp = stampMatch ? stampMatch[1] : null;
    const originalFinalName = stamp ? `dashcam_merged_${stamp}` : null;

    // Estimate final mp4 size: ~93% of input bytes
    const estimatedFinalBytes = Math.ceil(tsBytes * 0.93);
    const maxSegmentBytes = 256 * 1024 * 1024 * 1024;
    const needsSplit = estimatedFinalBytes > maxSegmentBytes;
    const segmentCount = needsSplit ? Math.ceil(estimatedFinalBytes / maxSegmentBytes) : 1;

    // Look for partial / corrupt mp4
    let partialOutputPath = null;
    let partialOutputSize = 0;
    if (originalFinalName) {
      const p = path.join(outputDir, `${originalFinalName}.mp4`);
      if (fs.existsSync(p)) {
        const s = fs.statSync(p);
        partialOutputPath = p;
        partialOutputSize = s.size;
      }
    }

    return {
      fileListPath: newest.path,
      fileListMtime: newest.mtime,
      tsFiles,
      tsFilesCount: tsFiles.length,
      tsFilesPresent: presentCount,
      tsFilesMissing: missing.length,
      tsBytes,
      tsGB: +(tsBytes / 1024 / 1024 / 1024).toFixed(2),
      estimatedFinalGB: +(estimatedFinalBytes / 1024 / 1024 / 1024).toFixed(2),
      needsSplit,
      segmentCount,
      partialOutputPath,
      partialOutputSize,
      originalFinalName
    };
  } catch (e) {
    return null;
  }
});

ipcMain.handle('dashcam:discard-resume', async (event, { fileListPath, tsFiles, partialOutputPath }) => {
  let removed = { ts: 0, list: 0, output: 0 };
  try {
    if (Array.isArray(tsFiles)) {
      for (const ts of tsFiles) {
        try {
          fs.unlinkSync(ts);
          removed.ts++;
        } catch (e) {}
      }
    }
    if (fileListPath) {
      try {
        fs.unlinkSync(fileListPath);
        removed.list = 1;
      } catch (e) {}
    }
    if (partialOutputPath) {
      try {
        if (fs.existsSync(partialOutputPath)) {
          fs.unlinkSync(partialOutputPath);
          removed.output = 1;
        }
      } catch (e) {}
    }
    return { success: true, removed };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('dashcam:merge', async (event, options) => {
  const {
    files,
    outputDir,
    outputName,
    tempDir = null,    // if null, uses outputDir
    cleanupTs = true,
    maxSegmentBytes = 256 * 1024 * 1024 * 1024,  // 256 GB per output
    resumeFrom = null  // { fileListPath, tsFiles, outputName, needsSplit, segmentTime, estimatedFinalBytes, totalInputBytes, totalInputSeconds } | null
  } = options;

  if (!Array.isArray(files) || files.length === 0) {
    return { success: false, error: 'No files to merge' };
  }

  if (activeMerger) {
    return { success: false, error: 'Another merge is already running' };
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Resolve temp dir: explicit choice or fallback chain
  const candidates = [];
  if (tempDir && tempDir.trim()) candidates.push({ dir: tempDir.trim(), source: 'user-specified temp' });
  candidates.push({ dir: outputDir, source: 'output folder' });
  candidates.push({ dir: require('os').tmpdir(), source: 'system temp' });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const finalName = (outputName && outputName.trim() ? outputName.trim() : `dashcam_merged_${stamp}`).replace(/\.mp4$/i, '');
  let fileListPath = path.join(outputDir, `filelist_${stamp}.txt`);

  // Pre-compute total input size (sum of selected MP4s)
  let totalInputBytes = 0;
  for (const f of files) {
    try { totalInputBytes += fs.statSync(f).size; } catch (e) {}
  }

  // ===== Compute total duration via ffprobe (parallel, for segment splitting) =====
  let totalInputSeconds = 0;
  const durations = await Promise.all(files.map(async (f) => {
    try {
      const info = await ffprobeJson(f);
      const d = info && info.format ? parseFloat(info.format.duration) : 0;
      return d > 0 ? d : 0;
    } catch (e) { return 0; }
  }));
  totalInputSeconds = durations.reduce((a, b) => a + b, 0);

  // Estimated final output size: concat is -c copy, so ~93% of input size
  // (TS rewrap is slightly smaller than MP4 due to removing MP4 container overhead).
  const estimatedFinalBytes = Math.ceil(totalInputBytes * 0.93);
  const needsSplit = estimatedFinalBytes > maxSegmentBytes;
  const segmentCount = needsSplit ? Math.ceil(estimatedFinalBytes / maxSegmentBytes) : 1;
  // segment_time (sec): portion of total duration for each segment, ensuring
  // each output ≤ maxSegmentBytes. We use 95% to add safety margin against
  // variable bitrate — worst-case segment may slightly exceed maxSegmentBytes.
  const segmentTime = needsSplit
    ? Math.floor((totalInputSeconds / segmentCount) * 0.95)
    : 0;
  const segmentPattern = path.join(outputDir, `${finalName}_part%03d.mp4`);
  const finalPathSingle = path.join(outputDir, `${finalName}.mp4`);
  const finalPath = needsSplit ? segmentPattern : finalPathSingle;

  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dashcam:progress', payload);
    }
  };

  // Pre-flight disk check: pick first dir with enough free space for inputs + TS files (~2x input)
  // Use 1.95x to be safe (input + all TS + final output all coexist at peak).
  // If output is split into segments, we still need same total disk (segments + TS).
  let workingDir = null;
  let workingDirSource = null;
  const requiredBytes = Math.ceil(totalInputBytes * 1.95);
  const sendPreflight = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dashcam:progress', payload);
    }
  };

  // ===== Resume shortcut: skip preflight, derive workingDir from .ts file location =====
  if (resumeFrom) {
    // Use the dir of the first .ts file as workingDir; should already exist
    workingDir = path.dirname(resumeFrom.tsFiles[0]);
    workingDirSource = 'resumed session (TS folder)';
    sendPreflight({
      phase: 'preflight',
      message: `Resuming — using existing ${resumeFrom.tsFiles.length} TS segments in ${workingDir}`,
      tempDir: workingDir,
      tempDirSource: workingDirSource,
      resuming: true,
      tsReady: resumeFrom.tsFiles.length,
      needsSplit,
      segmentCount,
      estimatedFinalGB: +(estimatedFinalBytes / 1024 / 1024 / 1024).toFixed(2)
    });
  } else {
    for (const c of candidates) {
      try {
        if (!fs.existsSync(c.dir)) fs.mkdirSync(c.dir, { recursive: true });
        const stat = fs.statfsSync ? fs.statfsSync(c.dir) : null;
        // Node 18+ has statfsSync; fallback for older: use execSync
        let freeBytes = 0;
        if (stat) {
          freeBytes = stat.bavail * stat.bsize;
        } else {
          // best-effort fallback (Windows): use wmic or just trust existence
          freeBytes = Number.MAX_SAFE_INTEGER;
        }
        const freeGB = (freeBytes / 1024 / 1024 / 1024).toFixed(2);
        if (freeBytes >= requiredBytes) {
          workingDir = c.dir;
          workingDirSource = c.source;
          sendPreflight({
            phase: 'preflight',
            message: `Disk OK on ${c.source} (${freeGB} GB free, need ~${(requiredBytes / 1024 / 1024 / 1024).toFixed(2)} GB${needsSplit ? `, will split into ${segmentCount} parts` : ''})`,
            tempDir: workingDir,
            tempDirSource: workingDirSource,
            diskFreeBytes: freeBytes,
            requiredBytes,
            needsSplit,
            segmentCount,
            estimatedFinalGB: +(estimatedFinalBytes / 1024 / 1024 / 1024).toFixed(2)
          });
          break;
        } else {
          sendPreflight({
            phase: 'preflight',
            level: 'warn',
            message: `Skipping ${c.source} (${freeGB} GB free, need ~${(requiredBytes / 1024 / 1024 / 1024).toFixed(2)} GB)`,
            diskFreeBytes: freeBytes,
            requiredBytes
          });
        }
      } catch (e) {
        sendPreflight({ phase: 'preflight', level: 'warn', message: `Cannot check ${c.source}: ${e.message}` });
      }
    }
  }

  if (!workingDir) {
    return {
      success: false,
      error: `No directory has enough disk space. Need ~${(requiredBytes / 1024 / 1024 / 1024).toFixed(2)} GB for inputs + temp + output. Checked: ${candidates.map(c => c.source).join(', ')}.`
    };
  }

  // ===== Stats collector (CPU%, MEM MB, disk free, current output size) =====
  const startCpu = process.cpuUsage();
  let lastCpu = startCpu;
  let lastSampleAt = Date.now();
  let currentOutputBytes = 0;
  let currentSpeedStr = '';     // e.g. "5.3x"
  let currentBitrateStr = '';   // e.g. "12.3 Mb/s"
  let currentFpsStr = '';       // e.g. "60 fps"

  const collectStats = () => {
    const nowCpu = process.cpuUsage();
    const now = Date.now();
    const dtMs = now - lastSampleAt;
    const cpuDelta = (nowCpu.user - lastCpu.user) + (nowCpu.system - lastCpu.system);
    const cpuPct = dtMs > 0 ? Math.min(100, (cpuDelta / 1000) / dtMs * 100) : 0;
    lastCpu = nowCpu;
    lastSampleAt = now;

    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

    let diskFreeGB = null;
    try {
      // statfs is Node 18+; fall back to checking output dir size
      const s = fs.statfsSync(outputDir);
      diskFreeGB = +(s.bavail * s.bsize / 1024 / 1024 / 1024).toFixed(2);
    } catch (e) {}

    let outputSize = 0;
    if (needsSplit) {
      // Sum all matching part files (each ffmpeg-segment output)
      try {
        const dir = path.dirname(segmentPattern);
        const base = path.basename(segmentPattern).replace('%03d', '');
        const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\d\\d\\d', '\\d+') + '$');
        for (const f of fs.readdirSync(dir)) {
          if (re.test(f)) {
            try { outputSize += fs.statSync(path.join(dir, f)).size; } catch (e) {}
          }
        }
      } catch (e) {}
    } else if (fs.existsSync(finalPathSingle)) {
      try { outputSize = fs.statSync(finalPathSingle).size; } catch (e) {}
    }
    currentOutputBytes = outputSize;

    send({
      phase: 'stats',
      cpuPct: +cpuPct.toFixed(1),
      memMB,
      diskFreeGB,
      outputBytes: outputSize,
      totalInputBytes,
      ffmpegSpeed: currentSpeedStr,
      ffmpegBitrate: currentBitrateStr,
      ffmpegFps: currentFpsStr,
      tsTotal: files.length,
      tsDone: tsFilesDone,
      // eta1Ms set by convert.done; eta2Ms set by concat:progress (or fallback estimate)
      eta1Ms: cachedEtaMs,
      eta2Ms: (() => {
        if (cachedEta2Ms != null) return cachedEta2Ms;
        if (currentPhase === 'concat' && concatStartMs > 0 && totalConcatSeconds > 0) {
          const elapsed = Date.now() - concatStartMs;
          return Math.max(0, Math.round(elapsed * 0.15)); // rough estimate while ffmpeg parses
        }
        return null;
      })(),
      elapsedMs: phase1StartMs > 0 ? (Date.now() - phase1StartMs) : 0,
      timestamp: now
    });
  };

  let tsFilesDone = 0;
  let tsAvgMs = 0;        // rolling avg ms per TS
  let cachedEtaMs = null;   // set by convert.done / concat; read by stats poller
  let cachedEta2Ms = null; 
  let currentFileStart = 0; // ms timestamp when current file started
  let currentPhase = '';   // 'convert' | 'concat' | ''
  let statsTimer = null;
  const startStatsTimer = () => {
    if (statsTimer) return;
    lastCpu = process.cpuUsage();
    lastSampleAt = Date.now();
    statsTimer = setInterval(collectStats, 500);
  };
  const stopStatsTimer = () => {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  };

  const cancelledRef = { value: false };
  activeMerger = { cancelled: cancelledRef };

  const tsFiles = [];
  const tsTimings = []; // ms per TS conversion, for ETA
  const skippedInputs = []; // {file, reason} entries for files that failed MP4→TS
  let totalConcatSeconds = 0;
  let concatElapsedMs = 0;
  let concatStartMs = 0;
  let phase1StartMs = 0;
  let phase1Ms = 0;            // total Phase 1 wall time; 0 on resume
  let currentFileStartMs = 0;

  const formatHMS = (sec) => {
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h > 0 ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };

  try {
    startStatsTimer();

    // ===== Resume path: skip Phase 1 if we have valid TS files from a previous session =====
    if (resumeFrom) {
      // Validate all referenced .ts files exist + have content
      const missing = [];
      let tsBytes = 0;
      for (const ts of resumeFrom.tsFiles) {
        try {
          const s = fs.statSync(ts);
          if (s.size === 0) missing.push(ts + ' (empty)');
          else tsBytes += s.size;
        } catch (e) {
          missing.push(ts + ' (not found)');
        }
      }
      if (missing.length > 0) {
        return {
          success: false,
          error: `Cannot resume — ${missing.length} TS file(s) missing or empty:\n${missing.slice(0, 5).join('\n')}${missing.length > 5 ? `\n... and ${missing.length - 5} more` : ''}\n\nPlease run a fresh merge instead.`
        };
      }

      // Verify the .ts files match the current input set (count match)
      if (resumeFrom.tsFiles.length !== files.length) {
        return {
          success: false,
          error: `Cannot resume — file count mismatch: session has ${resumeFrom.tsFiles.length} TS segments, but you selected ${files.length} input files.\n\nRun a fresh merge to use the new file list.`
        };
      }

      // Delete any partial/corrupt output mp4 from the previous attempt.
      // (If a previous ffmpeg run was killed, moov atom is missing → file is unusable.)
      // Derive original output paths from resumeFrom.originalFinalName (same dir as TS)
      const resumBaseDir = path.dirname(resumeFrom.tsFiles[0]);
      const originalFinalName = resumeFrom.originalFinalName;
      let resumeFinal = null;
      let resumeSegPattern = null;
      if (originalFinalName) {
        resumeFinal = path.join(resumBaseDir, `${originalFinalName}.mp4`);
        // segmentPattern was based on outputDir; in resume the workingDir IS the TS dir.
        resumeSegPattern = path.join(resumBaseDir, `${originalFinalName}_part%03d.mp4`);
      }
      try {
        if (resumeFinal && fs.existsSync(resumeFinal)) {
          try {
            fs.unlinkSync(resumeFinal);
            sendPreflight && sendPreflight({ phase: 'preflight', message: `Removed incomplete output: ${path.basename(resumeFinal)}` });
          } catch (e) {
            return { success: false, error: `Cannot remove incomplete output file: ${e.message}` };
          }
        }
        // Also clean any segment outputs from a prior split run
        if (resumeFrom.needsSplit && resumeSegPattern) {
          try {
            const dir = path.dirname(resumeSegPattern);
            const base = path.basename(resumeSegPattern).replace('%03d', '');
            const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\d\\d\\d', '\\d+') + '$');
            for (const f of fs.readdirSync(dir)) {
              if (re.test(f)) {
                try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
              }
            }
          } catch (e) {}
        }
      } catch (e) {}

      // Populate state from resumeFrom so Phase 2 can run
      tsFiles.push(...resumeFrom.tsFiles);
      tsFilesDone = tsFiles.length;
      fileListPath = resumeFrom.fileListPath;
      // totalInputBytes / totalInputSeconds / estimatedFinalBytes / needsSplit /
      // segmentCount / segmentTime / segmentPattern / finalPathSingle / finalPath
      // are all already computed from the saved snapshot.

      phase1StartMs = Date.now();  // virtual phase1 time for elapsed display
      phase1Ms = 0;                // skipped on resume; report 0 so phase1 ETA shows 0:00
      send({
        phase: 'convert',
        stage: 'skipped',
        tsIndex: tsFiles.length,
        tsTotal: tsFiles.length,
        file: '(resumed from previous session)',
        fileSize: 0,
        eta1Ms: 0,
        tempDir: workingDir,
        tempDirSource: workingDirSource,
        message: `Resumed: ${tsFiles.length} TS segments ready (${(tsBytes / 1024 / 1024 / 1024).toFixed(1)} GB)`
      });
    } else {
      // ===== Phase 1: MP4 -> TS =====
      phase1StartMs = Date.now();
    for (let i = 0; i < files.length; i++) {
      if (cancelledRef.value) throw new Error('Cancelled');

      const file = files[i];
      const tsFile = path.join(workingDir, `part${String(i + 1).padStart(4, '0')}.ts`);
      tsFiles.push(tsFile);

      const fileSize = (() => { try { return fs.statSync(file).size; } catch (e) { return 0; } })();
      currentFileStartMs = Date.now();
      currentPhase = 'convert';
      // Rolling average from completed files (tsTimings holds already-completed times)
      const doneSoFar = tsTimings.length;
      const tsAvgForEta = tsAvgMs > 0 ? tsAvgMs : 3000; // default 3s if no history yet
      const remainingMs = doneSoFar < files.length
        ? Math.round(tsAvgForEta * (files.length - doneSoFar))
        : 0;
      cachedEtaMs = remainingMs;
      const t0 = Date.now();
      send({
        phase: 'convert',
        stage: 'starting',
        tsIndex: i + 1,
        tsTotal: files.length,
        file: path.basename(file),
        fileSize,
        eta1Ms: remainingMs,
        tempDir: workingDir,
        tempDirSource: workingDirSource,
        message: `Converting ${path.basename(file)} -> TS (${workingDirSource})`
      });

      let convertError = null;
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
          '-i', file,
          '-c', 'copy',
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-f', 'mpegts',
          tsFile
        ], { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg TS exit ${code}: ${stderr.slice(-300)}`));
        });
        proc.on('error', reject);
        activeMerger.proc = proc;
      }).catch((err) => {
        // Input file is unreadable / truncated (e.g. missing moov atom from a
        // crashed recording). Skip it instead of aborting the whole merge.
        convertError = err;
      });

      if (convertError) {
        const reason = convertError.message.includes('moov atom')
          ? 'truncated/corrupt (no moov atom)'
          : convertError.message;
        skippedInputs.push({ file: path.basename(file), reason });
        // Roll back the .ts entry so concat ignores this slot
        tsFiles.pop();
        try { fs.unlinkSync(tsFile); } catch (e) {}
        send({
          phase: 'convert',
          stage: 'skipped',
          tsIndex: i + 1,
          tsTotal: files.length,
          file: path.basename(file),
          fileSize,
          message: `Skipped ${path.basename(file)}: ${reason}`
        });
        continue;
      }

      const dt = Date.now() - t0;
      tsTimings.push(dt);
      tsFilesDone = i + 1;

      const avgMs = tsTimings.reduce((a, b) => a + b, 0) / tsTimings.length;
      const remaining = avgMs * (files.length - (i + 1));
      cachedEtaMs = remaining;
      const mbPerSec = dt > 0 ? (fileSize / 1024 / 1024) / (dt / 1000) : 0;
      send({
        phase: 'convert',
        stage: 'done',
        tsIndex: i + 1,
        tsTotal: files.length,
        file: path.basename(file),
        fileSize,
        lastMs: dt,
        avgMs: tsAvgMs,
        etaMs: remaining,
        eta1Ms: remaining,
        mbPerSec: +mbPerSec.toFixed(1),
        elapsedMs: Date.now() - phase1StartMs,
        message: `Converted ${i + 1}/${files.length} (${mbPerSec.toFixed(1)} MB/s, ETA ${Math.ceil(remaining / 1000)}s)`
      });
    }
    phase1Ms = Date.now() - phase1StartMs;

    if (cancelledRef.value) throw new Error('Cancelled');

    if (tsFiles.length === 0) {
      const list = skippedInputs.map((s) => `• ${s.file} (${s.reason})`).join('\n');
      throw new Error(
        `All ${files.length} input file(s) failed MP4 → TS conversion:\n${list}`
      );
    }

    // ===== Write filelist (paths quoted to handle spaces) =====
    const listContent = tsFiles
      .map((t) => `file '${t.replace(/\\/g, '/')}'`)
      .join('\n') + '\n';
    fs.writeFileSync(fileListPath, listContent, 'utf8');
    }

    // ===== Phase 2: Concat TS -> MP4 (or split into segments if oversized) =====
    send({
      phase: 'concat',
      stage: 'starting',
      tsTotal: tsFiles.length,
      needsSplit,
      segmentCount,
      totalSeconds: totalInputSeconds,
      message: needsSplit
        ? `Concatenating ${tsFiles.length} TS segments → ${segmentCount} parts (≤ ${(maxSegmentBytes / 1024 / 1024 / 1024).toFixed(0)} GB each)...`
        : `Concatenating ${tsFiles.length} TS segments...`
    });

    concatStartMs = Date.now();
    currentPhase = 'concat';
    cachedEtaMs = null;
    totalConcatSeconds = 0;
    const ffmpegArgs = needsSplit
      ? [
          '-y', '-nostdin', '-hide_banner', '-loglevel', 'info',
          '-f', 'concat', '-safe', '0',
          '-i', fileListPath,
          '-c', 'copy',
          '-fflags', '+genpts',
          '-f', 'segment',
          '-segment_time', String(segmentTime),
          '-reset_timestamps', '1',
          segmentPattern
        ]
      : [
          '-y', '-nostdin', '-hide_banner', '-loglevel', 'info',
          '-f', 'concat', '-safe', '0',
          '-i', fileListPath,
          '-c', 'copy',
          '-fflags', '+genpts',
          finalPath
        ];
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs, { windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        // Try to extract total duration from input first
        const durMatch = s.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})/);
        if (durMatch && totalConcatSeconds === 0) {
          totalConcatSeconds =
            parseInt(durMatch[1]) * 3600 +
            parseInt(durMatch[2]) * 60 +
            parseInt(durMatch[3]);
        }
        // Capture ffmpeg parser details
        const speedMatch = s.match(/speed=\s*([\d.]+)x/);
        if (speedMatch) currentSpeedStr = speedMatch[1] + 'x';
        const brMatch = s.match(/bitrate=\s*([\d.]+\s*\w+\/s)/);
        if (brMatch) currentBitrateStr = brMatch[1];
        const fpsMatch = s.match(/fps=\s*(\d+)/);
        if (fpsMatch) currentFpsStr = fpsMatch[1] + ' fps';

        const timeMatch = s.match(/time=(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?/);
        if (timeMatch) {
          const cur = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
          const elapsed = Date.now() - concatStartMs;

          // ETA computation: prefer duration-based when we know total duration,
          // otherwise fall back to a rough outputBytes-based estimate.
          // Output is ~93% of input; rate is reproducible across inputs since -c copy.
          let etaMs = null;
          if (totalConcatSeconds > 0 && cur > 0) {
            etaMs = Math.round(elapsed / cur * (totalConcatSeconds - cur));
          } else if (totalConcatSeconds > 0) {
            // cur == 0: at the very start; show the wall-clock estimate of full duration
            // (use avg concat rate from prior runs if known, otherwise null)
            etaMs = null;
          } else {
            // No duration parsed yet — estimate from output bytes rate
            if (currentOutputBytes > 0 && elapsed > 0 && estimatedFinalBytes > 0) {
              const bytesPerMs = currentOutputBytes / elapsed;
              const remainingBytes = Math.max(0, estimatedFinalBytes - currentOutputBytes);
              etaMs = Math.round(remainingBytes / bytesPerMs);
            }
          }
          // Sanitize: clamp negatives, cap at 24h (display-friendly)
          if (etaMs != null) {
            if (etaMs < 0) etaMs = 0;
            if (etaMs > 24 * 3600 * 1000) etaMs = 24 * 3600 * 1000;
          }

          const mbPerSec = elapsed > 0 ? (currentOutputBytes / 1024 / 1024) / (elapsed / 1000) : 0;
          cachedEta2Ms = etaMs;
          send({
            phase: 'concat',
            stage: 'progress',
            currentSeconds: cur,
            totalSeconds: totalConcatSeconds,
            elapsedMs: elapsed,
            etaMs,
            eta2Ms: etaMs,
            mbPerSec: +mbPerSec.toFixed(1),
            ffmpegSpeed: currentSpeedStr,
            ffmpegBitrate: currentBitrateStr,
            ffmpegFps: currentFpsStr,
            outputBytes: currentOutputBytes,
            message: totalConcatSeconds > 0
              ? `Concatenating: ${formatHMS(cur)} / ${formatHMS(totalConcatSeconds)}`
              : `Concatenating... ${(currentOutputBytes / 1024 / 1024).toFixed(0)} MB written`
          });
        }
      });
      proc.on('close', (code) => {
        concatElapsedMs = Date.now() - concatStartMs;
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg concat exit ${code}: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
      activeMerger.proc = proc;
    });

    // ===== Cleanup TS =====
    if (cleanupTs) {
      for (const t of tsFiles) {
        try { fs.unlinkSync(t); } catch (e) {}
      }
      try { fs.unlinkSync(fileListPath); } catch (e) {}
    }

    // ===== Collect final output(s) =====
    let finalOutputs = [];     // [{ path, size }]
    let totalFinalBytes = 0;
    if (needsSplit) {
      // Glob pattern: enumerate part000.mp4, part001.mp4, ... in order
      const dir = path.dirname(segmentPattern);
      const basePattern = path.basename(segmentPattern).replace('%03d', '');
      const re = new RegExp('^' + basePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\d\\d\\d', '(\\d+)') + '$');
      try {
        const allFiles = fs.readdirSync(dir);
        const matches = allFiles
          .filter(f => re.test(f))
          .sort();
        for (const f of matches) {
          const p = path.join(dir, f);
          try {
            const st = fs.statSync(p);
            finalOutputs.push({ path: p, size: st.size });
            totalFinalBytes += st.size;
          } catch (e) {}
        }
      } catch (e) {}
    } else {
      try {
        const st = fs.statSync(finalPathSingle);
        finalOutputs.push({ path: finalPathSingle, size: st.size });
        totalFinalBytes = st.size;
      } catch (e) {}
    }

    stopStatsTimer();
    send({
      phase: 'done',
      success: true,
      outputPath: needsSplit ? null : finalPathSingle,
      outputPaths: finalOutputs,
      size: totalFinalBytes,
      segmentCount: finalOutputs.length,
      split: needsSplit,
      phase1Ms,
      phase2Ms: concatElapsedMs,
      avgSpeedMBps: +(totalFinalBytes / 1024 / 1024 / ((phase1Ms + concatElapsedMs) / 1000)).toFixed(1),
      skippedInputs: skippedInputs.slice(),     // [{file, reason}] of corrupt inputs skipped
      skippedCount: skippedInputs.length,
      message: needsSplit
        ? (skippedInputs.length
            ? `Merge complete: ${finalOutputs.length} parts (${(totalFinalBytes / 1024 / 1024 / 1024).toFixed(2)} GB) — ${skippedInputs.length} input file(s) skipped (corrupt/truncated)`
            : `Merge complete: ${finalOutputs.length} parts, total ${(totalFinalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`)
        : (skippedInputs.length
            ? `Merge complete (${(totalFinalBytes / 1024 / 1024 / 1024).toFixed(2)} GB) — ${skippedInputs.length} input file(s) skipped (corrupt/truncated)`
            : 'Merge complete')
    });

    return {
      success: true,
      outputPath: needsSplit ? null : finalPathSingle,
      outputPaths: finalOutputs,
      size: totalFinalBytes,
      split: needsSplit,
      segmentCount: finalOutputs.length,
      skippedCount: skippedInputs.length,
      skippedInputs: skippedInputs.slice()
    };
  } catch (err) {
    stopStatsTimer();
    // Cleanup partial output if cancelled/failed
    if (cancelledRef.value) {
      // Try to delete the primary finalPath (covers both single and segment-pattern path)
      try { fs.unlinkSync(finalPath); } catch (e) {}
      // If split, also try to glob-delete any partial segments that were created
      if (needsSplit) {
        try {
          const dir = path.dirname(segmentPattern);
          const base = path.basename(segmentPattern).replace('%03d', '');
          const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\d\\d\\d', '\\d+') + '$');
          for (const f of fs.readdirSync(dir)) {
            if (re.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
          }
        } catch (e) {}
      }
      for (const t of tsFiles) { try { fs.unlinkSync(t); } catch (e) {} }
      try { fs.unlinkSync(fileListPath); } catch (e) {}
      send({ phase: 'cancelled', message: 'Cancelled by user' });
      return { success: false, cancelled: true, error: 'Cancelled by user' };
    }
    send({ phase: 'error', error: err.message });
    return { success: false, error: err.message };
  } finally {
    stopStatsTimer();
    activeMerger = null;
  }
});

ipcMain.handle('dashcam:cancel', async () => {
  if (!activeMerger) return { success: false, error: 'No active merge' };
  activeMerger.cancelled.value = true;
  if (activeMerger.proc) {
    try { activeMerger.proc.kill('SIGTERM'); } catch (e) {}
    // On Windows, SIGTERM doesn't really work; use kill()
    try { activeMerger.proc.kill(); } catch (e) {}
  }
  return { success: true };
});

ipcMain.handle('dashcam:reveal', async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { success: false };
  const { shell } = require('electron');
  shell.showItemInFolder(filePath);
  return { success: true };
});
