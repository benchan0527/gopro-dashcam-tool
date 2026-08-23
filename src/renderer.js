let selectedFiles = [];
let processedResults = [];
let currentSRTContent = '';
let currentFileName = '';

// Debug: log when renderer loads
console.log('[Renderer] Loading...');

// Initialize with null checks - don't crash if electronAPI is not available
if (!electronAPI) {
  console.error('[Renderer] ERROR: electronAPI is not available!');
  document.addEventListener('DOMContentLoaded', () => {
    const statusDiv = document.createElement('div');
    statusDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#ff4444;color:white;padding:10px;text-align:center;z-index:9999;';
    statusDiv.textContent = 'Error: electronAPI not available!';
    document.body.prepend(statusDiv);
  });
}

// Get path and fs from electronAPI if available
let path = electronAPI?.path || null;
let fs = electronAPI?.fs || null;
if (path && fs) {
  console.log('[Renderer] Got path/fs from electronAPI');
} else {
  console.log('[Renderer] path/fs not available, some features may be limited');
}

const dropZone = document.getElementById('dropZone');
const selectedFilesDiv = document.getElementById('selectedFiles');
const fileList = document.getElementById('fileList');
const processBtn = document.getElementById('processBtn');
const clearBtn = document.getElementById('clearBtn');
const sortByDateBtn = document.getElementById('sortByDateBtn');
const mergeBtn = document.getElementById('mergeBtn');
const mergeSRTOnlyBtn = document.getElementById('mergeSRTOnlyBtn');
const mergeSRTCheckbox = document.getElementById('mergeSRT');
const mergeSection = document.getElementById('mergeSection');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const statusMessage = document.getElementById('statusMessage');
const previewSection = document.getElementById('previewSection');
const previewContent = document.getElementById('previewContent');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');

// Merge UI elements
const outputDirInput = document.getElementById('outputDir');
const selectOutputBtn = document.getElementById('selectOutputBtn');
const sortByDateCheck = document.getElementById('sortByDate');
const addSubtitlesCheck = document.getElementById('addSubtitles');
const startMergeBtn = document.getElementById('startMergeBtn');
const mergeProgressBar = document.getElementById('mergeProgressBar');
const mergeProgressText = document.getElementById('mergeProgressText');
const mergeStatus = document.getElementById('mergeStatus');

dropZone.addEventListener('click', async () => {
  if (!electronAPI) {
    alert('Error: electronAPI not available.');
    return;
  }
  const result = await electronAPI.selectFiles();
  if (!result.canceled && result.files.length > 0) {
    addFiles(result.files);
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  
  // Accept MP4, LRV and SRT files
  const files = Array.from(e.dataTransfer.files)
    .map(f => f.path)
    .filter(f => f.toLowerCase().endsWith('.mp4') || f.toLowerCase().endsWith('.lrv') || f.toLowerCase().endsWith('.srt'));
  
  if (files.length > 0) {
    addFiles(files);
  }
});

function addFiles(files) {
  for (const file of files) {
    const lowerFile = file.toLowerCase();
    let ext = '.mp4';
    if (lowerFile.endsWith('.srt')) ext = '.srt';
    else if (lowerFile.endsWith('.lrv')) ext = '.lrv';
    
    if (ext === '.srt' && path && fs) {
      // For SRT files, find corresponding MP4 in same directory
      const baseName = path.basename(file, '.srt');
      const dir = path.dirname(file);
      const mp4Path = path.join(dir, baseName + '.MP4');
      const mp4PathLower = path.join(dir, baseName + '.mp4');
      
      // Check if MP4 exists
      let actualMp4 = mp4Path;
      if (!fs.existsSync(mp4Path)) {
        actualMp4 = mp4PathLower;
      }
      
      if (fs.existsSync(actualMp4) && !selectedFiles.includes(actualMp4)) {
        selectedFiles.push(actualMp4);
      }
    } else if (ext === '.lrv' && path && fs) {
      // For LRV files, find corresponding MP4 in same directory
      const baseName = path.basename(file, '.lrv').replace('GL', 'GX');
      const dir = path.dirname(file);
      const mp4Path = path.join(dir, baseName + '.MP4');
      const mp4PathLower = path.join(dir, baseName + '.mp4');
      
      let actualMp4 = mp4Path;
      if (!fs.existsSync(mp4Path)) {
        actualMp4 = mp4PathLower;
      }
      
      if (fs.existsSync(actualMp4) && !selectedFiles.includes(actualMp4)) {
        selectedFiles.push(actualMp4);
      }
    } else {
      if (!selectedFiles.includes(file)) {
        selectedFiles.push(file);
      }
    }
  }
  renderFileList();
}

function renderFileList() {
  if (selectedFiles.length > 0) {
    selectedFilesDiv.classList.remove('hidden');
    fileList.innerHTML = '';
    
    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const fileName = file.split(/[\\/]/).pop();
      const result = processedResults.find(r => r.file === fileName);
      
      let statusHtml = '<span class="file-status">Pending</span>';
      if (result) {
        if (result.success) {
          statusHtml = '<span class="file-status success">Completed</span>';
        } else {
          statusHtml = `<span class="file-status error">${result.error}</span>`;
        }
      }
      
      const fileItem = document.createElement('div');
      fileItem.className = 'file-item';
      fileItem.draggable = true;
      fileItem.dataset.index = i;
      fileItem.innerHTML = `
        <span class="drag-handle" title="Drag to reorder">☰</span>
        <span class="file-number">${i + 1}.</span>
        <span class="file-name">${fileName}</span>
        ${statusHtml}
      `;
      
      // Drag events for reordering
      fileItem.addEventListener('dragstart', handleDragStart);
      fileItem.addEventListener('dragover', handleDragOver);
      fileItem.addEventListener('drop', handleDrop);
      fileItem.addEventListener('dragend', handleDragEnd);
      
      fileList.appendChild(fileItem);
    }
  } else {
    selectedFilesDiv.classList.add('hidden');
  }
}

let draggedItem = null;

function handleDragStart(e) {
  draggedItem = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function handleDrop(e) {
  e.preventDefault();
  if (draggedItem !== this) {
    const fromIndex = parseInt(draggedItem.dataset.index);
    const toIndex = parseInt(this.dataset.index);
    
    // Reorder array
    const [movedFile] = selectedFiles.splice(fromIndex, 1);
    selectedFiles.splice(toIndex, 0, movedFile);
    
    // Also reorder processed results if they exist
    if (processedResults.length > 0) {
      const movedResult = processedResults.splice(fromIndex, 1);
      processedResults.splice(toIndex, 0, movedResult[0]);
    }
    
    renderFileList();
  }
}

function handleDragEnd() {
  this.classList.remove('dragging');
  draggedItem = null;
}

// Get file creation date for sorting
function getFileDate(filePath) {
  if (!path || !fs) return 0;
  try {
    const stats = fs.statSync(filePath);
    // Use ctime (creation time) on Windows, mtime on other systems
    return stats.ctime || stats.mtime || 0;
  } catch (e) {
    return 0;
  }
}

// Merge multiple SRT contents into one, renumbering subtitles, with time adjustment
function mergeSRTContents(srtContents) {
  let merged = '';
  let subtitleIndex = 1;
  let timeOffset = 0;
  
  for (const srtContent of srtContents) {
    // Calculate duration of this SRT
    let maxEndTime = 0;
    const timeRegex = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/g;
    let match;
    while ((match = timeRegex.exec(srtContent)) !== null) {
      const endTime = parseSRTTime(match[2]);
      if (endTime > maxEndTime) {
        maxEndTime = endTime;
      }
    }
    
    // Reset regex for second pass
    timeRegex.lastIndex = 0;
    
    const lines = srtContent.split('\n');
    let inSubtitle = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Check if this is a subtitle number
      if (/^\d+$/.test(trimmed)) {
        inSubtitle = true;
        merged += subtitleIndex + '\n';
        subtitleIndex++;
        continue;
      }
      
      // Check if this is a timecode line - adjust time with offset
      if (trimmed.includes('-->')) {
        const parts = trimmed.split('-->');
        const startTime = parseSRTTime(parts[0].trim());
        const endTime = parseSRTTime(parts[1].trim());
        
        const newStartTime = msToSRTTime(startTime + timeOffset);
        const newEndTime = msToSRTTime(endTime + timeOffset);
        
        merged += `${newStartTime} --> ${newEndTime}\n`;
        continue;
      }
      
      // Skip empty lines that are not between subtitles
      if (trimmed === '' && inSubtitle) {
        merged += '\n';
        inSubtitle = false;
        continue;
      }
      
      // Add the text content
      if (trimmed !== '') {
        merged += trimmed + '\n';
      }
    }
    
    // Add offset for next file (continuous, no gap)
    timeOffset += maxEndTime + 1000;
  }
  
  return merged;
}

processBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;
  
  const mergeSRT = mergeSRTCheckbox?.checked || false;
  
  // If merge SRT option is selected and multiple SRT files, sort by date
  let filesToProcess = [...selectedFiles];
  if (mergeSRT && selectedFiles.length > 1 && path && fs) {
    // Sort by MP4 creation date (earliest first)
    filesToProcess.sort((a, b) => {
      const dateA = getFileDate(a);
      const dateB = getFileDate(b);
      return dateA - dateB;
    });
  }
  
  progressSection.classList.add('active');
  processBtn.disabled = true;
  statusMessage.className = 'status-message';
  statusMessage.textContent = '';
  previewSection.classList.remove('active');
  
  try {
    const results = await electronAPI.processFiles(filesToProcess);
    processedResults = results;
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    if (successful.length > 0) {
      // If merge SRT option is selected, merge all SRT contents
      if (mergeSRT && successful.length > 1) {
        currentSRTContent = mergeSRTContents(successful.map(r => r.srtContent));
        currentFileName = 'merged_' + new Date().toISOString().slice(0,10) + '.srt';
      } else {
        const firstResult = successful[0];
        currentSRTContent = firstResult.srtContent;
        currentFileName = firstResult.file.replace(/\.[^.]+$/, '') + '.srt';
      }
      
      previewContent.textContent = currentSRTContent;
      previewSection.classList.add('active');
      
      statusMessage.className = 'status-message success';
      statusMessage.textContent = `Successfully processed ${successful.length} file(s)`;
    } else {
      statusMessage.className = 'status-message error';
      statusMessage.textContent = `Failed to process files: ${failed[0]?.error || 'Unknown error'}`;
    }
    
    renderFileList();
  } catch (error) {
    statusMessage.className = 'status-message error';
    statusMessage.textContent = `Error: ${error.message}`;
  } finally {
    progressSection.classList.remove('active');
    processBtn.disabled = false;
  }
});

clearBtn.addEventListener('click', () => {
  selectedFiles = [];
  processedResults = [];
  currentSRTContent = '';
  previewSection.classList.remove('active');
  statusMessage.className = 'status-message';
  renderFileList();
});

// Sort files by date (earliest first)
sortByDateBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;

  if (!electronAPI) {
    alert('electronAPI not available for sorting');
    return;
  }

  // Use FFprobe-based sorting for accurate video date sorting
  sortByDateBtn.disabled = true;
  sortByDateBtn.textContent = 'Sorting...';

  try {
    const result = await electronAPI.sortFilesByDate(selectedFiles);

    if (result.success) {
      // Update this.files with the sorted objects (including date/duration/codec)
      result.files.forEach((sortedFile) => {
        const existing = this.files.find((f) => f.path === sortedFile.path);
        if (existing) {
          existing.date = sortedFile.date;
          existing.duration = sortedFile.duration;
          existing.codec = sortedFile.codec;
          existing.width = sortedFile.width;
          existing.height = sortedFile.height;
        }
      });

      // Re-sort this.files to match the sorted order
      const sortedPaths = result.files.map((f) => f.path);
      this.files.sort((a, b) => {
        return sortedPaths.indexOf(a.path) - sortedPaths.indexOf(b.path);
      });

      this.renderList();
      updateMergeStatus(`Sorted ${result.files.length} files by video date (earliest first)`);
    } else {
      alert('Sorting failed: ' + result.error);
    }
  } catch (error) {
    alert('Error sorting: ' + error.message);
  } finally {
    sortByDateBtn.disabled = false;
    sortByDateBtn.textContent = 'Sort by Date (Earliest First)';
  }
});

copyBtn.addEventListener('click', async () => {
  if (currentSRTContent) {
    try {
      await navigator.clipboard.writeText(currentSRTContent);
      const originalText = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = originalText, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }
});

saveBtn.addEventListener('click', async () => {
  if (currentSRTContent) {
    const result = await electronAPI.saveSRT(currentSRTContent, currentFileName);
    if (!result.canceled && !result.error) {
      statusMessage.className = 'status-message success';
      statusMessage.textContent = `Saved to ${result.filePath}`;
    } else if (result.error) {
      statusMessage.className = 'status-message error';
      statusMessage.textContent = `Error saving: ${result.error}`;
    }
  }
});

if (electronAPI) {
  electronAPI.onProgress((data) => {
    const percent = (data.current / data.total) * 100;
    progressBar.style.width = percent + '%';
    progressText.textContent = `Processing ${data.file} (${data.current}/${data.total})`;
  });
} else {
  console.warn('[Renderer] electronAPI not available, progress updates disabled');
}

// Merge button click handler
mergeBtn.addEventListener('click', () => {
  if (selectedFiles.length > 0) {
    mergeSection.style.display = 'block';
    updateMergeStatus(`Loaded ${selectedFiles.length} videos for merging`);
    startMergeBtn.disabled = false;
  } else {
    updateMergeStatus('Please add videos first using the drop zone above');
  }
});

// Merge SRT only button - directly merge SRT files without processing
mergeSRTOnlyBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) {
    alert('Please drag files first');
    return;
  }
  
  if (!path || !fs) {
    alert('File system not available');
    return;
  }
  
  // Find all SRT files from selected MP4 files
  const srtFiles = [];
  for (const mp4File of selectedFiles) {
    const dir = path.dirname(mp4File);
    const baseName = path.basename(mp4File, path.extname(mp4File));
    const srtPath = path.join(dir, baseName + '.srt');
    const srtPathUpper = path.join(dir, baseName + '.SRT');
    
    if (fs.existsSync(srtPath)) {
      srtFiles.push({ path: srtPath, mp4: mp4File });
    } else if (fs.existsSync(srtPathUpper)) {
      srtFiles.push({ path: srtPathUpper, mp4: mp4File });
    }
  }
  
  if (srtFiles.length === 0) {
    alert('No SRT files found for the selected videos');
    return;
  }
  
  // Sort by MP4 date (earliest first)
  srtFiles.sort((a, b) => {
    const dateA = getFileDate(a.mp4);
    const dateB = getFileDate(b.mp4);
    return dateA - dateB;
  });
  
  // Parse and merge SRT with time adjustment
  const mergedSRT = mergeSRTWithTimeAdjustment(srtFiles, fs);
  
  // Save merged SRT
  currentSRTContent = mergedSRT;
  currentFileName = 'merged_' + new Date().toISOString().slice(0,10) + '.srt';
  
  previewContent.textContent = currentSRTContent;
  previewSection.classList.add('active');
  
  // Auto save
  const saveResult = await electronAPI.saveSRT(currentSRTContent, currentFileName);
  if (!saveResult.canceled) {
    statusMessage.className = 'status-message success';
    statusMessage.textContent = `Merged ${srtFiles.length} SRT files and saved to ${saveResult.filePath || currentFileName}`;
  }
});

// Parse time string to milliseconds (format: HH:MM:SS,mmm)
function parseSRTTime(timeStr) {
  const match = timeStr.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const ms = parseInt(match[4], 10);
  
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
}

// Convert milliseconds to SRT time format
function msToSRTTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;
  
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

// Merge SRT files with time adjustment to make them continuous
function mergeSRTWithTimeAdjustment(srtFiles, fs) {
  let mergedSRT = '';
  let subtitleIndex = 1;
  let timeOffset = 0;
  
  for (const srtFile of srtFiles) {
    try {
      const content = fs.readFileSync(srtFile.path, 'utf8');
      
      // First, calculate the duration of this SRT file
      let maxEndTime = 0;
      const timeRegex = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/g;
      let match;
      while ((match = timeRegex.exec(content)) !== null) {
        const endTime = parseSRTTime(match[2]);
        if (endTime > maxEndTime) {
          maxEndTime = endTime;
        }
      }
      
      // Now re-process the file with the time offset
      const lines = content.split('\n');
      let inSubtitle = false;
      let lastTimecode = '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        
        // Check if this is a subtitle number
        if (/^\d+$/.test(trimmed)) {
          mergedSRT += subtitleIndex + '\n';
          subtitleIndex++;
          inSubtitle = true;
          continue;
        }
        
        // Check if this is a timecode line
        if (trimmed.includes('-->')) {
          const parts = trimmed.split('-->');
          const startTime = parseSRTTime(parts[0].trim());
          const endTime = parseSRTTime(parts[1].trim());
          
          const newStartTime = msToSRTTime(startTime + timeOffset);
          const newEndTime = msToSRTTime(endTime + timeOffset);
          
          mergedSRT += `${newStartTime} --> ${newEndTime}\n`;
          lastTimecode = newEndTime;
          continue;
        }
        
        // Add empty line between subtitles
        if (trimmed === '' && inSubtitle) {
          mergedSRT += '\n';
          inSubtitle = false;
          continue;
        }
        
        // Add the text content
        if (trimmed !== '') {
          mergedSRT += trimmed + '\n';
        }
      }
      
      // Add offset for next file
      timeOffset += maxEndTime; // No gap - continuous
      
    } catch (e) {
      console.error('Error reading SRT:', srtFile.path, e);
    }
  }
  
  return mergedSRT;
}

// Select output directory
selectOutputBtn.addEventListener('click', async () => {
  const result = await electronAPI.selectOutputDir();
  if (!result.canceled && result.filePath) {
    outputDirInput.value = result.filePath;
    updateMergeStatus(`Output directory: ${result.filePath}`);
  }
});

// Start merge button
startMergeBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) {
    updateMergeStatus('No videos selected!');
    return;
  }

  const outputDir = outputDirInput.value || '';
  const sortByDate = sortByDateCheck.checked;
  const addSubtitles = addSubtitlesCheck.checked;

  startMergeBtn.disabled = true;
  mergeProgressBar.style.width = '0%';
  mergeProgressText.textContent = 'Starting merge...';
  updateMergeStatus('Starting merge process...');

  try {
    const result = await electronAPI.mergeVideos({
      files: selectedFiles,
      outputDir: outputDir,
      sortByDate: sortByDate,
      addSubtitles: addSubtitles
    });

    if (result.success) {
      mergeProgressBar.style.width = '100%';
      mergeProgressText.textContent = 'Merge completed!';
      updateMergeStatus(`Merge completed successfully!\nOutput: ${result.outputPath}\nSize: ${result.fileSize}`);
    } else {
      updateMergeStatus(`Merge failed: ${result.error}`);
      mergeProgressText.textContent = 'Merge failed';
    }
  } catch (error) {
    updateMergeStatus(`Error: ${error.message}`);
    mergeProgressText.textContent = 'Error occurred';
  } finally {
    startMergeBtn.disabled = false;
  }
});

// Update merge status display
function updateMergeStatus(message) {
  const timestamp = new Date().toLocaleTimeString();
  mergeStatus.textContent = `[${timestamp}] ${message}`;
}

// Listen for merge progress updates
if (electronAPI) {
  electronAPI.onMergeProgress((data) => {
    if (data.progress !== undefined) {
      mergeProgressBar.style.width = data.progress + '%';
    }
    if (data.message) {
      updateMergeStatus(data.message);
    }
    if (data.stage) {
      mergeProgressText.textContent = data.stage;
    }
  });
}

// Nominatim controls
const startNominatimBtn = document.getElementById('startNominatimBtn');
const stopNominatimBtn = document.getElementById('stopNominatimBtn');
const checkNominatimBtn = document.getElementById('checkNominatimBtn');
const viewLogsBtn = document.getElementById('viewLogsBtn');
const nominatimStatus = document.getElementById('nominatimStatus');
const nominatimConsole = document.getElementById('nominatimConsole');

function logNominatim(msg) {
  if (nominatimConsole) {
    const time = new Date().toLocaleTimeString();
    nominatimConsole.textContent = `[${time}] ${msg}\n` + nominatimConsole.textContent;
  }
  console.log('[Nominatim]', msg);
}

function updateNominatimStatus(running, message) {
  if (nominatimStatus) {
    nominatimStatus.textContent = message;
    nominatimStatus.className = 'nominatim-status ' + (running ? 'running' : 'stopped');
  }
  if (startNominatimBtn) startNominatimBtn.disabled = running;
  if (stopNominatimBtn) stopNominatimBtn.disabled = !running;
}

if (startNominatimBtn) {
  startNominatimBtn.addEventListener('click', async () => {
    if (!electronAPI) {
      alert('electronAPI not available');
      return;
    }
    logNominatim('Starting Nominatim...');
    if (nominatimStatus) {
      nominatimStatus.textContent = 'Starting...';
      nominatimStatus.className = 'nominatim-status checking';
    }
    try {
      const result = await electronAPI.startNominatim();
      logNominatim(result.message || result.success ? 'Started' : 'Failed');
      if (result.success) {
        setTimeout(async () => {
          const status = await electronAPI.checkNominatim();
          updateNominatimStatus(status.running, status.message);
          logNominatim(status.message);
        }, 3000);
      } else {
        updateNominatimStatus(false, result.message);
      }
    } catch (e) {
      logNominatim('Error: ' + e.message);
      updateNominatimStatus(false, 'Error: ' + e.message);
    }
  });
}

if (stopNominatimBtn) {
  stopNominatimBtn.addEventListener('click', async () => {
    if (!electronAPI) return;
    logNominatim('Stopping Nominatim...');
    if (nominatimStatus) {
      nominatimStatus.textContent = 'Stopping...';
      nominatimStatus.className = 'nominatim-status checking';
    }
    try {
      const result = await electronAPI.stopNominatim();
      logNominatim(result.message || 'Stopped');
      updateNominatimStatus(false, result.message || 'Stopped');
    } catch (e) {
      logNominatim('Error: ' + e.message);
      updateNominatimStatus(false, 'Error: ' + e.message);
    }
  });
}

if (checkNominatimBtn) {
  checkNominatimBtn.addEventListener('click', async () => {
    if (!electronAPI) return;
    logNominatim('Checking status...');
    if (nominatimStatus) {
      nominatimStatus.textContent = 'Checking...';
      nominatimStatus.className = 'nominatim-status checking';
    }
    try {
      const result = await electronAPI.checkNominatim();
      updateNominatimStatus(result.running, result.message);
      logNominatim(result.message);
    } catch (e) {
      logNominatim('Error: ' + e.message);
      updateNominatimStatus(false, 'Error: ' + e.message);
    }
  });
}

if (viewLogsBtn) {
  viewLogsBtn.addEventListener('click', async () => {
    if (!electronAPI) return;
    logNominatim('Fetching container logs...');
    try {
      const result = await electronAPI.getNominatimLogs();
      if (result.success) {
        nominatimConsole.textContent = result.logs;
        logNominatim('Logs updated');
      } else {
        logNominatim('Error: ' + result.message);
      }
    } catch (e) {
      logNominatim('Error: ' + e.message);
    }
  });
}

// ===== Dashcam Merger UI =====
const dc = {
  files: [],          // [{path, name, size, mtime, duration, codec, selected}]
  probedCache: new Map(),
  scanning: false,
  merging: false,
  scanStartTime: 0,

  $(id) { return document.getElementById(id); },

  fmtBytes(b) {
    if (b == null) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  },

  fmtDate(d) {
    if (!d) return '-';
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return '-';
    const y = dt.getFullYear();
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    const da = String(dt.getDate()).padStart(2, '0');
    const h = String(dt.getHours()).padStart(2, '0');
    const mi = String(dt.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${da} ${h}:${mi}`;
  },

  fmtDuration(s) {
    if (!s || isNaN(s)) return '-';
    s = Math.round(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  },

  fmtEta(ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '-';
    if (ms < 1000) return '<1s';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m${rs}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h${rm}m`;
  },

  async pickFolder() {
    const r = await electronAPI.dashcamPickFolder();
    if (r.canceled) return;
    this.$('dc-source-folder').value = r.folder;
    this.$('dc-rescan').disabled = false;
    if (!this.$('dc-output-folder').value) {
      this.$('dc-output-folder').value = r.folder + '_merged';
    }
    await this.scan(r.folder);
  },

  async scan(folder) {
    if (this.scanning) return;
    this.scanning = true;
    this.scanStartTime = Date.now();
    this.files = [];
    this.probedCache.clear();
    this.$('dc-file-list').innerHTML = '<div class="hint" style="padding:14px">Scanning...</div>';
    this.$('dc-folder-summary').textContent = '';
    this.$('dc-list-summary').textContent = '';

    const r = await electronAPI.dashcamScanFolder(folder);
    if (!r.success) {
      this.$('dc-file-list').innerHTML = `<div class="hint" style="padding:14px;color:#f88">Error: ${r.error}</div>`;
      this.scanning = false;
      return;
    }

    this.files = r.files.map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size,
      mtime: f.mtime,
      date: null,
      duration: 0,
      codec: '',
      width: 0,
      height: 0,
      selected: true
    }));

    this.$('dc-folder-summary').textContent =
      `Found ${this.files.length} video(s) in ${Date.now() - this.scanStartTime}ms.`;

    this.applySort();
    this.renderList();
    this.scanning = false;

    // Probe in background (don't block UI)
    this.probeAllInBackground();
  },

  async probeAllInBackground() {
    const concurrency = 4;
    let idx = 0;
    const total = this.files.length;
    const update = () => this.renderList();

    const worker = async () => {
      while (idx < total) {
        const i = idx++;
        const f = this.files[i];
        if (this.probedCache.has(f.path)) {
          const p = this.probedCache.get(f.path);
          f.duration = p.duration; f.codec = p.codec;
          f.width = p.width; f.height = p.height;
          f.date = p.creationTime;
        } else {
          const r = await electronAPI.dashcamProbe(f.path);
          if (r.success) {
            this.probedCache.set(f.path, r);
            f.duration = r.duration; f.codec = r.codec;
            f.width = r.width; f.height = r.height;
            f.date = r.creationTime;
          }
        }
        if (i % 8 === 0) update();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    update();
    this.updateSummary();
  },

  applySort() {
    const mode = this.$('dc-sort').value;
    const arr = this.files;
    switch (mode) {
      case 'name-asc':    arr.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'name-desc':   arr.sort((a, b) => b.name.localeCompare(a.name)); break;
      case 'date-asc':    arr.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)); break;
      case 'date-desc':   arr.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)); break;
      case 'size-asc':    arr.sort((a, b) => a.size - b.size); break;
      case 'size-desc':   arr.sort((a, b) => b.size - a.size); break;
      case 'mtime-asc':   arr.sort((a, b) => a.mtime - b.mtime); break;
      case 'mtime-desc':  arr.sort((a, b) => b.mtime - a.mtime); break;
    }
  },

  renderList() {
    const list = this.$('dc-file-list');
    if (this.files.length === 0) {
      list.innerHTML = '<div class="hint" style="padding:14px">No videos found.</div>';
      return;
    }
    const rows = this.files.map((f, i) => {
      const dim = (f.width && f.height) ? `${f.width}x${f.height}` : '';
      const codec = f.codec ? `${f.codec}${dim ? ' ' + dim : ''}` : '';
      const sel = f.selected ? 'selected' : '';
      const dateStr = f.date ? this.fmtDate(f.date) : (f.mtime ? this.fmtDate(new Date(f.mtime)) : '-');
      return `
        <div class="file-row ${sel}" data-idx="${i}">
          <input type="checkbox" data-idx="${i}" ${f.selected ? 'checked' : ''}>
          <span class="fname" title="${f.path}">${f.name}</span>
          <span class="fdate" title="${f.date ? f.date.toISOString() : ''}">${dateStr}</span>
          <span class="fsize">${this.fmtBytes(f.size)}</span>
          <span class="fdur">${this.fmtDuration(f.duration)}</span>
          <span class="fcodec">${codec || '-'}</span>
        </div>`;
    }).join('');
    list.innerHTML = rows;

    list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const i = parseInt(e.target.dataset.idx);
        this.files[i].selected = e.target.checked;
        e.target.closest('.file-row').classList.toggle('selected', e.target.checked);
        this.updateSummary();
      });
    });
    this.updateSummary();
  },

  updateSummary() {
    const sel = this.files.filter((f) => f.selected);
    const totalSize = sel.reduce((a, b) => a + b.size, 0);
    const totalDur  = sel.reduce((a, b) => a + (b.duration || 0), 0);
    this.$('dc-list-summary').textContent =
      `${sel.length} of ${this.files.length} selected — ${this.fmtBytes(totalSize)}, total ${this.fmtDuration(totalDur)}`;
    this.$('dc-start-merge').disabled = sel.length < 2 || this.merging;
  },

  selectAll(v) { this.files.forEach((f) => f.selected = v); this.renderList(); },
  invert() { this.files.forEach((f) => f.selected = !f.selected); this.renderList(); },

  async pickOutput() {
    const r = await electronAPI.dashcamPickOutput();
    if (r.canceled) return;
    this.$('dc-output-folder').value = r.folder;
    await this.detectResume();
  },

  async pickTemp() {
    const r = await electronAPI.dashcamPickOutput();
    if (r.canceled) return;
    this.$('dc-temp-folder').value = r.folder;
    await this.detectResume();
  },

  // ===== Resume mode =====
  // Scans outputDir for an orphaned filelist_*.txt + .ts files from a previous
  // crashed/cancelled merge. If found, shows the resume banner with details.
  async detectResume() {
    this._resumeState = null;
    const banner = this.$('dc-resume-banner');
    if (banner) banner.style.display = 'none';

    const outDir = this.$('dc-output-folder').value.trim();
    if (!outDir) return;

    try {
      const state = await electronAPI.dashcamDetectResume({ outputDir: outDir });
      if (!state || state.tsFilesPresent === 0) return;
      this._resumeState = state;
      this.renderResumeBanner(state);
    } catch (e) {
      // Silent — detection is best-effort
      console.warn('Resume detection failed:', e);
    }
  },

  renderResumeBanner(state) {
    const banner = this.$('dc-resume-banner');
    const summary = this.$('dc-resume-summary');
    if (!banner || !summary) return;

    const dt = new Date(state.fileListMtime);
    const dateStr = dt.toLocaleString();
    const fileListName = state.fileListPath.split(/[\\/]/).pop();
    const outName = state.originalFinalName
      ? `${state.originalFinalName}.mp4`
      : '(output)';
    const needsSplit = state.needsSplit;
    const segmentCount = state.segmentCount;

    let html = `
      <div><span class="hint-inline">Session:</span> ${fileListName}</div>
      <div><span class="hint-inline">Started:</span> ${dateStr}</div>
      <div><span class="hint-inline">TS segments:</span>
        ${state.tsFilesPresent}/${state.tsFilesCount} present
        (${state.tsGB} GB)
        ${state.tsFilesMissing > 0 ? `<span class="warn">— ${state.tsFilesMissing} missing</span>` : ''}
      </div>
      <div><span class="hint-inline">Output:</span> ${outName}
        ≈ ${state.estimatedFinalGB} GB
        ${needsSplit ? ` -> ${segmentCount} parts`
          + ` (<= ${(state.maxSegmentBytes / 1024 / 1024 / 1024).toFixed(0)} GB`
          + ` or <= ${Math.floor((state.maxSegmentSeconds || 43200) / 3600)} h each)` : ''}
      </div>
    `;
    if (state.partialOutputPath) {
      const partialMB = (state.partialOutputSize / 1024 / 1024).toFixed(0);
      html += `<div class="warn">⚠ Partial output exists: ${state.partialOutputPath} (${partialMB} MB) — will be removed on resume</div>`;
    }

    summary.innerHTML = html;
    banner.style.display = 'block';
  },

  dismissResume() {
    const banner = this.$('dc-resume-banner');
    if (banner) banner.style.display = 'none';
    this._resumeState = null;
  },

  async discardResume() {
    if (!this._resumeState) return;
    const state = this._resumeState;
    const tsGB = state.tsGB;
    const ok = confirm(
      `Discard previous session?\n\n` +
      `This deletes:\n` +
      `  • ${state.tsFilesCount} .ts files (${tsGB} GB)\n` +
      `  • filelist file\n` +
      `  • partial output (if any)\n\n` +
      `Continue?`
    );
    if (!ok) return;

    const r = await electronAPI.dashcamDiscardResume({
      fileListPath: state.fileListPath,
      tsFiles: state.tsFiles,
      partialOutputPath: state.partialOutputPath
    });
    if (r && r.success) {
      alert(`Removed: ${r.removed.ts} .ts, ${r.removed.list} filelist, ${r.removed.output} output`);
    } else if (r && r.error) {
      alert(`Discard failed: ${r.error}`);
    }
    this.dismissResume();
  },

  async startMerge() {
    const sel = this.files.filter((f) => f.selected);
    if (sel.length < 2) return;
    const outDir = this.$('dc-output-folder').value.trim();
    if (!outDir) {
      alert('Please choose an output folder.');
      return;
    }
    this.merging = true;
    this._intotal = sel.reduce((a, b) => a + (b.size || 0), 0);
    this.resetInfoPanel();
    this.setInfo('intotal', this.fmtBytes(this._intotal));
    this.$('dc-start-merge').disabled = true;
    this.$('dc-cancel').disabled = false;
    this.$('dc-result').style.display = 'none';
    this.$('dc-progress-text').textContent = 'Starting...';
    this.$('dc-progress-bar').style.width = '0%';
    this.$('dc-eta').textContent = '';
    this.$('dc-current-file').textContent = '';
    this.setInfo('stage', 'Starting');

    const options = {
      files: sel.map((f) => f.path),
      outputDir: outDir,
      outputName: this.$('dc-output-name').value.trim(),
      tempDir: this.$('dc-temp-folder').value.trim() || null,
      cleanupTs: this.$('dc-cleanup-ts').checked,
      maxSegmentBytes: this.$('dc-enable-split').checked
        ? Math.max(1, parseInt(this.$('dc-max-gb').value, 10) || 256) * 1024 * 1024 * 1024
        : Infinity,           // effectively disable splitting
      maxSegmentSeconds: this.$('dc-enable-split').checked
        ? Math.max(1, parseInt(this.$('dc-max-hours').value, 10) || 12) * 3600
        : Infinity
    };

    // If resume state is detected and selected file count matches, attach resumeFrom
    if (this._resumeState &&
        this._resumeState.tsFilesPresent === sel.length &&
        this._resumeState.tsFilesCount === sel.length) {
      options.resumeFrom = {
        fileListPath: this._resumeState.fileListPath,
        tsFiles: this._resumeState.tsFiles,
        originalFinalName: this._resumeState.originalFinalName,
        needsSplit: this._resumeState.needsSplit,
        // Override defaults if splitting is still enabled; otherwise let merge
        // recompute needsSplit=false from its Infinity defaults.
        ...(this.$('dc-enable-split').checked ? {
          maxSegmentBytes: options.maxSegmentBytes,
          maxSegmentSeconds: options.maxSegmentSeconds
        } : {})
      };
      if (!options.outputName && this._resumeState.originalFinalName) {
        options.outputName = `${this._resumeState.originalFinalName}_resumed`;
      }
      this.dismissResume();
    }

    const r = await electronAPI.dashcamMerge(options);
    this.merging = false;
    this.$('dc-cancel').disabled = true;
    this.updateSummary();

    const result = this.$('dc-result');
    result.style.display = 'block';
    if (r.success) {
      result.classList.remove('error');
      if (r.split && r.outputPaths && r.outputPaths.length > 0) {
        // Multi-segment output
        const rows = r.outputPaths.map((o, i) =>
          `<div style="margin-top:4px;font-size:0.9rem">
             <span style="color:#8899aa">Part ${i + 1}:</span>
             ${o.path} <span style="color:#8899aa">(${this.fmtBytes(o.size)})</span>
           </div>`
        ).join('');
        result.innerHTML = `
          <div><strong style="color:#00ff88">Merge complete (${r.outputPaths.length} parts)</strong></div>
          <div style="margin-top:6px;color:#8899aa">Total: ${this.fmtBytes(r.size)}</div>
          ${rows}
          <button class="btn btn-secondary" id="dc-reveal" style="margin-top:8px">Show first in Explorer</button>
          <button class="btn btn-secondary" id="dc-reveal-dir" style="margin-top:8px">Show folder</button>`;
        const revealDirPath = r.outputPaths[0].path.replace(/[^\\\/]+$/, '');
        this.$('dc-reveal').addEventListener('click', () => electronAPI.dashcamReveal(r.outputPaths[0].path));
        this.$('dc-reveal-dir').addEventListener('click', () => electronAPI.dashcamReveal(revealDirPath));
      } else {
        result.innerHTML = `
          <div><strong style="color:#00ff88">Merge complete</strong></div>
          <div style="margin-top:6px">${r.outputPath}</div>
          <div style="margin-top:4px;color:#8899aa">Size: ${this.fmtBytes(r.size)}</div>
          <button class="btn btn-secondary" id="dc-reveal">Show in Explorer</button>`;
        this.$('dc-reveal').addEventListener('click', () => electronAPI.dashcamReveal(r.outputPath));
      }
    } else if (r.cancelled) {
      result.classList.add('error');
      result.innerHTML = `<strong>Cancelled.</strong> ${r.error || ''}`;
    } else {
      result.classList.add('error');
      result.innerHTML = `<strong>Failed.</strong> ${r.error || 'Unknown error'}`;
    }
  },

  async cancel() {
    if (!this.merging) return;
    this.$('dc-cancel').disabled = true;
    this.$('dc-progress-text').textContent = 'Cancelling...';
    await electronAPI.dashcamCancel();
  },

  initProgress() {
    electronAPI.onDashcamProgress((p) => {
      const bar = this.$('dc-progress-bar');
      const text = this.$('dc-progress-text');
      const eta = this.$('dc-eta');
      const cur = this.$('dc-current-file');

      if (p.phase === 'preflight') {
        // Disk preflight: show temp dir + disk status
        this.setInfo('stage', 'Checking disk space');
        text.textContent = p.message || 'Checking disk space...';
        if (p.needsSplit) {
          this.setInfo('stage', `Will split into ${p.segmentCount} parts`);
        }
        if (p.level === 'warn') {
          console.warn('[preflight]', p.message);
        } else if (p.tempDir) {
          console.log('[preflight] using temp dir:', p.tempDir, '(' + p.tempDirSource + ')');
        }
      } else if (p.phase === 'convert') {
        const pct = p.tsTotal > 0 ? Math.round(((p.tsIndex) / p.tsTotal) * 90) : 0;
        bar.style.width = pct + '%';
        cur.textContent = p.file ? p.file : '';
        text.textContent = p.message || `Converting ${p.tsIndex}/${p.tsTotal}`;
        eta.textContent = (p.etaMs != null) ? `ETA: ${this.fmtEta(p.etaMs)}` : '';

        if (p.stage === 'skipped') {
          this.setInfo('stage', `Skipped ${p.tsIndex}/${p.tsTotal} (corrupt)`, false, true);
        } else {
          this.setInfo('stage', p.stage === 'done'
            ? `Converting  ·  ${p.tsIndex}/${p.tsTotal}`
            : 'Converting');
        }
        this.setInfo('current', p.file || '-');
        this.setInfo('progress', `${p.tsIndex}/${p.tsTotal} files`);
        this.setInfo('speed', p.mbPerSec != null ? `${p.mbPerSec} MB/s` : '-');
        this.setInfo('bitrate', '-');
        this.setInfo('fps', '-');
        this.setInfo('eta1', p.etaMs != null ? this.fmtEta(p.etaMs) : '-');
        this.setInfo('eta2', '-');
        this.setInfo('elapsed', p.elapsedMs != null ? this.fmtEta(p.elapsedMs) : '-');
        this.setInfo('outsize', '-');
        this.setInfo('intotal', this.fmtBytes(p.fileSize ? (this._intotal || 0) : 0));
        this.setInfo('ts', `${p.tsIndex}/${p.tsTotal}`);
      } else if (p.phase === 'concat') {
        if (p.stage === 'starting') {
          bar.style.width = '91%';
          text.textContent = p.message || 'Concatenating...';
          eta.textContent = p.totalSeconds
            ? `Preparing concat: ${this.fmtDuration(p.totalSeconds)} total...`
            : '';
          this.setInfo('stage', 'Concatenating');
          this.setInfo('current', p.totalSeconds
            ? `0 / ${this.fmtDuration(p.totalSeconds)}`
            : '-');
          this.setInfo('progress', '-');
          this.setInfo('eta1', '-');
          this.setInfo('eta2', '-');
          this.setInfo('speed', '-');
          this.setInfo('bitrate', '-');
          this.setInfo('fps', '-');
          this.setInfo('outsize', '-');
        } else {
          // progress stage
          bar.style.width = '95%';
          text.textContent = p.message || 'Concatenating...';
          if (p.etaMs != null && p.etaMs >= 0) {
            eta.textContent = p.totalSeconds
              ? `ETA: ${this.fmtEta(p.etaMs)}  (${this.fmtDuration(p.currentSeconds || 0)} / ${this.fmtDuration(p.totalSeconds || 0)})`
              : `ETA: ${this.fmtEta(p.etaMs)}`;
          } else {
            eta.textContent = '';
          }

          this.setInfo('stage', 'Concatenating  ·  muxing');
          this.setInfo('current', `${this.fmtDuration(p.currentSeconds || 0)} / ${this.fmtDuration(p.totalSeconds || 0)}`);
          this.setInfo('progress', p.totalSeconds
            ? `${Math.round(((p.currentSeconds || 0) / p.totalSeconds) * 100)}%`
            : '-');
          this.setInfo('speed', p.mbPerSec != null ? `${p.mbPerSec} MB/s` : '-');
          this.setInfo('bitrate', p.ffmpegBitrate || '-');
          this.setInfo('fps', p.ffmpegFps || '-');
          this.setInfo('eta1', '-');
          this.setInfo('eta2', p.etaMs != null ? this.fmtEta(p.etaMs) : '-');
          this.setInfo('elapsed', p.elapsedMs != null ? this.fmtEta(p.elapsedMs) : '-');
          this.setInfo('outsize', p.outputBytes != null ? this.fmtBytes(p.outputBytes) : '-');
          this.setInfo('ts', `${p.tsTotal || this._tsTotal || '-'}/${p.tsTotal || this._tsTotal || '-'}`);
        }
        } else if (p.phase === 'stats') {
        // Live stats — update the 5-row panel every 500ms.
        // Preserve phase-level data from the last convert/concat event,
        // and use stats payload for system-level metrics.
        if (p.eta1Ms != null) this.setInfo('eta1', this.fmtEta(p.eta1Ms));
        if (p.eta2Ms != null) this.setInfo('eta2', this.fmtEta(p.eta2Ms));
        if (p.elapsedMs != null) this.setInfo('elapsed', this.fmtEta(p.elapsedMs));
        // file progress from stats (convert phase shows 0-based index until convert event fires)
        if (p.tsTotal) this._tsTotal = p.tsTotal;
        if (p.tsDone != null) {
          this.setInfo('progress', `${p.tsDone}/${p.tsTotal}`);
        }
        this.setInfo('ts', `${p.tsDone || 0}/${p.tsTotal || '-'}`);
        this.setInfo('cpu', `${p.cpuPct.toFixed(0)}%`, p.cpuPct > 80);
        this.setInfo('mem', `${p.memMB} MB`);
        this.setInfo('disk', p.diskFreeGB != null ? `${p.diskFreeGB} GB` : '-',
                     p.diskFreeGB != null && p.diskFreeGB < 5);
        this.setInfo('outsize', p.outputBytes != null ? this.fmtBytes(p.outputBytes) : '-');
        this.setInfo('intotal', this.fmtBytes(p.totalInputBytes));
        if (p.ffmpegSpeed) this.setInfo('speed', p.ffmpegSpeed);
        if (p.ffmpegBitrate) this.setInfo('bitrate', p.ffmpegBitrate);
        if (p.ffmpegFps) this.setInfo('fps', p.ffmpegFps);
      } else if (p.phase === 'done') {
        bar.style.width = '100%';
        let doneMsg = `Done — ${this.fmtBytes(p.size)}, phase1 ${this.fmtEta(p.phase1Ms)}, phase2 ${this.fmtEta(p.phase2Ms)}`;
        if (p.skippedCount > 0) {
          const names = (p.skippedInputs || []).map((s) => s.file).join(', ');
          doneMsg += ` — ${p.skippedCount} skipped (corrupt): ${names}`;
        }
        text.textContent = doneMsg;
        eta.textContent = '';
        this.setInfo('stage', p.skippedCount > 0 ? 'Complete (with skips)' : 'Complete', true);
        this.setInfo('current', '-');
        this.setInfo('progress', '100%', true);
        this.setInfo('speed', p.avgSpeedMBps != null ? `${p.avgSpeedMBps} MB/s avg` : '-');
        this.setInfo('outsize', this.fmtBytes(p.size), true);
        this.setInfo('eta1', '-');
        this.setInfo('eta2', '-');
        this.setInfo('elapsed', this.fmtEta((p.phase1Ms || 0) + (p.phase2Ms || 0)));
      } else if (p.phase === 'cancelled') {
        text.textContent = 'Cancelled';
        eta.textContent = '';
        this.setInfo('stage', 'Cancelled', false, true);
      } else if (p.phase === 'error') {
        text.textContent = 'Error';
        eta.textContent = '';
        this.setInfo('stage', 'Error', false, true);
      }
    });
  },

  setInfo(key, value, highlight = false, warn = false) {
    const el = this.$('dc-info-' + key);
    if (!el) return;
    el.textContent = value;
    el.classList.toggle('highlight', highlight);
    el.classList.toggle('warn', warn);
  },

  resetInfoPanel() {
    ['stage', 'current', 'progress', 'speed', 'bitrate', 'fps',
     'eta1', 'eta2', 'elapsed', 'outsize', 'intotal', 'disk',
     'cpu', 'mem', 'ts'].forEach((k) => this.setInfo(k, '-'));
    this._intotal = 0;
    this._tsTotal = 0;
  }
};

dc.initProgress();
dc.$('dc-pick-folder').addEventListener('click', () => dc.pickFolder());
dc.$('dc-rescan').addEventListener('click', () => {
  const f = dc.$('dc-source-folder').value;
  if (f) dc.scan(f);
});
dc.$('dc-sort-apply').addEventListener('click', () => { dc.applySort(); dc.renderList(); });
dc.$('dc-sort').addEventListener('change', () => { dc.applySort(); dc.renderList(); });
dc.$('dc-sel-all').addEventListener('click', () => dc.selectAll(true));
dc.$('dc-sel-none').addEventListener('click', () => dc.selectAll(false));
dc.$('dc-sel-invert').addEventListener('click', () => dc.invert());
dc.$('dc-pick-output').addEventListener('click', () => dc.pickOutput());
dc.$('dc-pick-temp').addEventListener('click', () => dc.pickTemp());
dc.$('dc-start-merge').addEventListener('click', () => dc.startMerge());
dc.$('dc-cancel').addEventListener('click', () => dc.cancel());
dc.$('dc-resume-go').addEventListener('click', () => dc.startMerge());
dc.$('dc-resume-discard').addEventListener('click', () => dc.discardResume());
dc.$('dc-resume-dismiss').addEventListener('click', () => dc.dismissResume());

// Toggle split options visibility
dc.$('dc-enable-split').addEventListener('change', (e) => {
  dc.$('dc-split-options').style.display = e.target.checked ? '' : 'none';
});
// Initial visibility (checked = show options)
dc.$('dc-split-options').style.display = dc.$('dc-enable-split').checked ? '' : 'none';

// Re-detect resume state when output-name changes (cheap scan)
dc.$('dc-output-name').addEventListener('change', () => dc.detectResume());

// Auto-detect resume on startup if output folder is pre-filled
if (dc.$('dc-output-folder').value.trim()) {
  setTimeout(() => dc.detectResume(), 500);
}

// =============================================================================
//  Video Splitter tab controller
// =============================================================================
const splitter = {
  files: [],   // [{ path, name, size }]
  splitting: false,

  $(id) { return document.getElementById(id); },

  fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i >= 2 ? 2 : 1)} ${u[i]}`;
  },

  fmtDuration(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return `${h}h${m}m`;
    if (m) return `${m}m${s}s`;
    return `${s}s`;
  },

  fmtEta(ms) {
    if (ms == null || ms < 0) return '-';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m${s % 60}s`;
  },

  addPickedFiles(picked) {
    if (!picked || !picked.length) return;
    for (const f of picked) {
      // Avoid duplicates by full path
      if (!this.files.some((x) => x.path === f.path)) this.files.push(f);
    }
    this.renderFiles();
    this.updateStartBtn();
  },

  async pickFiles() {
    const r = await electronAPI.dashcamPickSplitFiles();
    if (r.canceled) return;
    this.addPickedFiles(r.files);
  },

  clearFiles() {
    this.files = [];
    this.renderFiles();
    this.updateStartBtn();
  },

  removeFile(path) {
    this.files = this.files.filter((f) => f.path !== path);
    this.renderFiles();
    this.updateStartBtn();
  },

  renderFiles() {
    const list = this.$('sp-files-list');
    if (!list) return;
    if (!this.files.length) {
      list.innerHTML = '';
      this.$('sp-files-display').value = '';
      this.$('sp-files-summary').textContent = '';
      return;
    }
    this.$('sp-files-display').value = `${this.files.length} file(s) selected`;
    const totalSize = this.files.reduce((a, b) => a + (b.size || 0), 0);
    this.$('sp-files-summary').textContent =
      `Total: ${this.files.length} file(s), ${this.fmtBytes(totalSize)}`;

    list.innerHTML = this.files.map((f) => {
      const fileName = (f.name || '').replace(/[<>&"']/g, (c) => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
      }[c]));
      return `<div class="sp-file-row" data-path="${(f.path || '').replace(/"/g, '&quot;')}" style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${fileName}">${fileName}</span>
        <span style="flex:0 0 90px;text-align:right;color:#9ab;font-size:0.85em">${this.fmtBytes(f.size)}</span>
        <button class="btn btn-secondary sp-remove" data-path="${(f.path || '').replace(/"/g, '&quot;')}" style="padding:2px 8px;font-size:0.85em">Remove</button>
      </div>`;
    }).join('');
    list.querySelectorAll('.sp-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.removeFile(btn.dataset.path);
      });
    });
  },

  async pickOutput() {
    const r = await electronAPI.dashcamPickOutput();
    if (r.canceled) return;
    this.$('sp-output-folder').value = r.folder;
    this.updateStartBtn();
  },

  updateStartBtn() {
    const ok = this.files.length > 0
      && (this.$('sp-output-folder').value || '').trim()
      && !this.splitting;
    this.$('sp-start').disabled = !ok;
    this.$('sp-clear-files').disabled = this.files.length === 0;
  },

  setInfo(key, value, highlight = false, warn = false) {
    const el = this.$('sp-info-' + key);
    if (!el) return;
    el.textContent = value;
    el.classList.remove('warn', 'highlight');
    if (warn) el.classList.add('warn');
    else if (highlight) el.classList.add('highlight');
  },

  resetProgress() {
    this.$('sp-progress-bar').style.width = '0%';
    this.$('sp-progress-text').textContent = 'Starting...';
    this.$('sp-eta').textContent = '';
    this.$('sp-current-file').textContent = '';
    this.setInfo('stage', 'Starting');
    this.setInfo('current', '-');
    this.setInfo('progress', '0%');
    this.setInfo('parts', '0');
    this.setInfo('eta', '-');
    this.setInfo('elapsed', '-');
  },

  async startSplit() {
    if (this.splitting) return;
    if (!this.files.length) return;
    const outDir = (this.$('sp-output-folder').value || '').trim();
    if (!outDir) return;

    this.splitting = true;
    this.$('sp-start').disabled = true;
    this.$('sp-cancel').disabled = false;
    this.$('sp-result').style.display = 'none';
    this.resetProgress();

    const options = {
      files: this.files.map((f) => f.path),
      outputDir: outDir,
      outputName: this.$('sp-output-name').value.trim(),
      maxSegmentBytes: Math.max(1, parseInt(this.$('sp-max-gb').value, 10) || 256) * 1024 * 1024 * 1024,
      maxSegmentSeconds: Math.max(1, parseInt(this.$('sp-max-hours').value, 10) || 12) * 3600
    };

    const r = await electronAPI.dashcamSplit(options);
    this.splitting = false;
    this.$('sp-cancel').disabled = true;
    this.updateStartBtn();

    if (r.cancelled) {
      this.$('sp-result').style.display = 'block';
      this.$('sp-result').className = 'result-box warn';
      this.$('sp-result').textContent = 'Cancelled.';
      return;
    }
    if (!r.success) {
      this.$('sp-result').style.display = 'block';
      this.$('sp-result').className = 'result-box error';
      this.$('sp-result').textContent = `Failed: ${r.error || 'Unknown error'}`;
      return;
    }

    // Success — show result
    const out = r.outputPaths || [];
    const totalSize = out.reduce((a, b) => a + (b.size || 0), 0);
    const totalGB = (totalSize / 1024 / 1024 / 1024).toFixed(2);
    this.$('sp-progress-bar').style.width = '100%';
    let msg = `Done - ${out.length} part${out.length === 1 ? '' : 's'}, ${totalGB} GB`;
    if (r.skippedCount > 0) {
      const names = (r.skippedInputs || []).map((s) => s.file).join(', ');
      msg += ` - ${r.skippedCount} skipped: ${names}`;
    }
    this.$('sp-progress-text').textContent = msg;
    this.$('sp-eta').textContent = '';

    this.$('sp-result').style.display = 'block';
    this.$('sp-result').className = 'result-box';

    const revealDir = out.length ? out[0].path.split(/[\\/]/).slice(0, -1).join('\\') : '';
    let revealBtn = '';
    if (out.length) {
      const firstPath = out[0].path;
      revealBtn =
        `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary" id="sp-reveal-first">Reveal first part</button>
          <button class="btn btn-secondary" id="sp-reveal-dir">Open output folder</button>
        </div>`;
      setTimeout(() => {
        const r1 = this.$('sp-reveal-first');
        const r2 = this.$('sp-reveal-dir');
        if (r1) r1.addEventListener('click', () => electronAPI.dashcamReveal(firstPath));
        if (r2) r2.addEventListener('click', () => electronAPI.dashcamReveal(firstPath));
      }, 0);
    }

    const list = out.map((p) =>
      `<li style="margin:2px 0"><code>${p.path.split(/[\\/]/).pop()}</code> - ${this.fmtBytes(p.size)}</li>`
    ).join('');
    const skip = (r.skippedInputs && r.skippedInputs.length)
      ? `<div class="warn" style="margin-top:8px">Skipped ${r.skippedInputs.length}:<br>${
          r.skippedInputs.map((s) => `&bull; ${s.file} <em>(${s.reason})</em>`).join('<br>')
        }</div>` : '';

    this.$('sp-result').innerHTML = `
      <strong>Split complete:</strong> ${out.length} part${out.length === 1 ? '' : 's'}, ${totalGB} GB total.
      <ul style="margin-top:6px;padding-left:18px">${list}</ul>
      ${skip}
      ${revealBtn}
    `;
  },

  async cancelSplit() {
    await electronAPI.dashcamCancel();
  },

  init() {
    this.$('sp-add-files').addEventListener('click', () => this.pickFiles());
    this.$('sp-clear-files').addEventListener('click', () => this.clearFiles());
    this.$('sp-pick-output').addEventListener('click', () => this.pickOutput());
    this.$('sp-start').addEventListener('click', () => this.startSplit());
    this.$('sp-cancel').addEventListener('click', () => this.cancelSplit());

    // Listen ONLY to splitter-tagged events (phase:split or terminal cancelled/error)
    electronAPI.onDashcamProgress((p) => {
      if (p.phase !== 'split' && p.phase !== 'cancelled' && p.phase !== 'error') return;

      const bar = this.$('sp-progress-bar');
      const text = this.$('sp-progress-text');
      const eta = this.$('sp-eta');
      const cur = this.$('sp-current-file');

      if (p.phase === 'error') {
        text.textContent = 'Error';
        eta.textContent = '';
        this.setInfo('stage', 'Error', false, true);
        return;
      }
      if (p.phase === 'cancelled') {
        text.textContent = 'Cancelled.';
        eta.textContent = '';
        this.setInfo('stage', 'Cancelled', false, true);
        return;
      }
      if (p.phase !== 'split') return;

      if (p.stage === 'probing') {
        text.textContent = p.message || 'Probing...';
        this.setInfo('stage', 'Probing');
        this.setInfo('current', p.file || '-');
        cur.textContent = p.file || '';
      } else if (p.stage === 'starting') {
        text.textContent = p.message || `Splitting ${p.file}`;
        this.setInfo('stage', 'Splitting');
        this.setInfo('current', p.file || '-');
        this.setInfo('progress', '0%');
        cur.textContent = p.file || '';
      } else if (p.stage === 'progress') {
        bar.style.width = (p.pct != null ? p.pct.toFixed(0) : '0') + '%';
        text.textContent = p.message || `Splitting (${p.pct || 0}%)`;
        eta.textContent = p.etaMs != null ? `ETA: ${this.fmtEta(p.etaMs)}` : '';
        this.setInfo('progress', `${(p.pct || 0).toFixed(0)}%`);
        this.setInfo('eta', p.etaMs != null ? this.fmtEta(p.etaMs) : '-');
        this.setInfo('elapsed', p.elapsedMs != null ? this.fmtEta(p.elapsedMs) : '-');
      } else if (p.stage === 'fileDone') {
        cur.textContent = '';
        text.textContent = p.message || `File done`;
        this.setInfo('stage', `Next file (${p.fileIndex}/${p.fileTotal})`);
        this.setInfo('progress', '-');
        this.setInfo('eta', p.etaMs != null ? this.fmtEta(p.etaMs) : '-');
      } else if (p.stage === 'skipped') {
        text.textContent = p.message || `Skipped ${p.file}`;
        this.setInfo('stage', `Skipped`, false, true);
      } else if (p.stage === 'done') {
        bar.style.width = '100%';
        text.textContent = p.message || 'Done';
        eta.textContent = '';
        this.setInfo('stage', 'Complete', true);
        this.setInfo('current', '-');
        this.setInfo('progress', '100%', true);
        this.setInfo('eta', '-');
        const parts = p.totalParts || (this._parts || 0);
        this.setInfo('parts', String(parts), true);
        this.setInfo('elapsed', p.elapsedMs != null ? this.fmtEta(p.elapsedMs) : '-');
      }
    });
  }
};
splitter.init();
