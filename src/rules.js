const path = require("path");

const PROTECTED_PATTERNS = [
  "\\windows",
  "\\program files",
  "\\program files (x86)",
  "\\programdata",
  "\\$recycle.bin",
  "\\system volume information"
];

const SAFE_PATTERNS = [
  "\\temp",
  "\\tmp",
  "\\cache",
  "\\logs",
  "\\log",
  "\\downloads",
  "\\npm-cache",
  "\\appdata\\local\\temp"
];

const CAUTION_PATTERNS = [
  "\\users\\",
  "\\documents",
  "\\desktop",
  "\\onedrive",
  "\\pictures",
  "\\videos"
];

function normalizePath(targetPath) {
  return targetPath.toLowerCase().replace(/\//g, "\\");
}

function decideCategory(targetPath, isDirectory) {
  const normalized = normalizePath(targetPath);
  const fileName = path.basename(normalized);

  if (PROTECTED_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      risk: "forbidden",
      suggestion: "禁止删除",
      reason: "系统关键目录或系统保留区域，删除可能导致系统异常。"
    };
  }

  if (!isDirectory) {
    if ([".sys", ".dll", ".exe", ".drv"].includes(path.extname(fileName))) {
      return {
        risk: "forbidden",
        suggestion: "禁止删除",
        reason: "检测到系统/程序关键文件类型。"
      };
    }
    if ([".tmp", ".log", ".bak", ".old", ".cache"].includes(path.extname(fileName))) {
      return {
        risk: "safe",
        suggestion: "建议删除",
        reason: "常见临时或日志文件，通常可安全清理。"
      };
    }
  }

  if (SAFE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      risk: "safe",
      suggestion: "建议删除",
      reason: "常见缓存/临时目录，通常可清理。"
    };
  }

  if (CAUTION_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      risk: "caution",
      suggestion: "谨慎删除",
      reason: "用户数据相关目录，可能包含个人文件。"
    };
  }

  return {
    risk: "caution",
    suggestion: "谨慎删除",
    reason: "未命中明确规则，建议先确认用途。"
  };
}

module.exports = {
  decideCategory
};
