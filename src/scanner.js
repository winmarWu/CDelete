const fs = require("fs/promises");
const path = require("path");
const { decideCategory } = require("./rules");
const { annotateItems } = require("./ai");

const MAX_SCAN_ITEMS = Number(process.env.CDELETE_MAX_SCAN_ITEMS || 5000);
const MAX_FOLDERS_IN_REPORT = Number(process.env.CDELETE_MAX_FOLDERS || 120);
const MAX_FILES_IN_REPORT = Number(process.env.CDELETE_MAX_FILES || 120);
const STAT_CONCURRENCY = Number(process.env.CDELETE_STAT_CONCURRENCY || 24);

function toGB(bytes) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

function toMB(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function shouldSkipFolder(folderPath) {
  const lowered = folderPath.toLowerCase();
  return lowered.includes("\\$recycle.bin") || lowered.includes("\\system volume information");
}

async function safeStat(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

async function walkDrive(rootPath) {
  const folders = [];
  const files = [];
  const queue = [rootPath];
  let scannedCount = 0;

  while (queue.length > 0 && scannedCount < MAX_SCAN_ITEMS) {
    const currentDir = queue.shift();
    if (shouldSkipFolder(currentDir)) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    let folderSize = 0;
    for (let offset = 0; offset < entries.length && scannedCount < MAX_SCAN_ITEMS; offset += STAT_CONCURRENCY) {
      const remaining = MAX_SCAN_ITEMS - scannedCount;
      const size = Math.min(STAT_CONCURRENCY, remaining);
      const chunk = entries.slice(offset, offset + size);

      const inspected = await Promise.all(
        chunk.map(async (entry) => {
          const fullPath = path.join(currentDir, entry.name);
          const stat = await safeStat(fullPath);
          if (!stat) {
            return null;
          }
          return {
            path: fullPath,
            size: stat.size,
            isDirectory: entry.isDirectory()
          };
        })
      );

      for (const item of inspected) {
        if (!item) {
          continue;
        }
        scannedCount += 1;
        if (item.isDirectory) {
          queue.push(item.path);
          folders.push(item);
        } else {
          files.push(item);
        }
        folderSize += item.size;
      }
    }

    folders.push({
      path: currentDir,
      size: folderSize,
      isDirectory: true
    });
  }

  return {
    folders,
    files,
    scannedCount
  };
}

function buildClassifiedItems(items) {
  return items.map((item) => {
    const category = decideCategory(item.path, item.isDirectory);
    return {
      ...item,
      risk: category.risk,
      suggestion: category.suggestion,
      ruleReason: category.reason
    };
  });
}

function summarize(items) {
  const summary = {
    totalCount: items.length,
    safeCount: 0,
    cautionCount: 0,
    forbiddenCount: 0,
    estimatedReclaimBytes: 0
  };

  for (const item of items) {
    if (item.risk === "safe") {
      summary.safeCount += 1;
      summary.estimatedReclaimBytes += item.size;
    } else if (item.risk === "forbidden") {
      summary.forbiddenCount += 1;
    } else {
      summary.cautionCount += 1;
    }
  }
  return summary;
}

async function scanDrive(driveLetter, options = {}) {
  const driveRoot = `${driveLetter.toUpperCase()}:\\`;
  const stat = await safeStat(driveRoot);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`无法访问盘符 ${driveRoot}`);
  }

  const raw = await walkDrive(driveRoot);

  const topFolders = raw.folders
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_FOLDERS_IN_REPORT);

  const topFiles = raw.files
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_FILES_IN_REPORT);

  const classifiedFolders = buildClassifiedItems(topFolders);
  const classifiedFiles = buildClassifiedItems(topFiles);
  const merged = [...classifiedFolders, ...classifiedFiles];
  const enriched = await annotateItems(merged, {
    apiKey: options.aiApiKey,
    model: options.aiModel,
    strict: options.aiStrict !== false,
    batchSize: Number(options.aiBatchSize || 16),
    batchConcurrency: Number(options.aiBatchConcurrency || 3),
    maxAiItems: Number(options.maxAiItems || 80)
  });

  const folderSize = classifiedFolders.reduce((acc, item) => acc + item.size, 0);
  const fileSize = classifiedFiles.reduce((acc, item) => acc + item.size, 0);
  const summary = summarize(enriched);

  return {
    id: createId(),
    drive: driveRoot,
    scannedAt: new Date().toISOString(),
    scannedNodeCount: raw.scannedCount,
    stats: {
      folderSizeBytes: folderSize,
      folderSizeGB: toGB(folderSize),
      fileSizeBytes: fileSize,
      fileSizeGB: toGB(fileSize),
      estimatedReclaimBytes: summary.estimatedReclaimBytes,
      estimatedReclaimGB: toGB(summary.estimatedReclaimBytes),
      estimatedReclaimMB: toMB(summary.estimatedReclaimBytes),
      safeCount: summary.safeCount,
      cautionCount: summary.cautionCount,
      forbiddenCount: summary.forbiddenCount
    },
    items: enriched
  };
}

module.exports = {
  scanDrive
};
