const { jsonrepair } = require("jsonrepair");

const DEFAULT_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-reasoner";

const TEMPLATE_PATTERNS = [
  "命中规则库",
  "规则建议为",
  "请结合业务场景确认",
  "未命中明确规则"
];

function createRuleOnlyExplanation(item) {
  const suffix = item.isDirectory ? "目录" : "文件";
  const name = (item.path || "").split(/\\|\//).filter(Boolean).pop() || item.path || "未知路径";
  return {
    purpose: `该${suffix}「${name}」需要结合其所在目录和关联程序判断用途。`,
    riskSummary: `当前建议为「${item.suggestion}」，删除前请先确认是否仍被系统或应用引用。`,
    action: item.suggestion
  };
}

function stripMarkdownFence(text) {
  let s = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/im.exec(s);
  if (fence) {
    s = fence[1].trim();
  }
  return s;
}

function extractJsonObjectOrArray(text) {
  const cleaned = stripMarkdownFence(text);
  const firstObj = cleaned.indexOf("{");
  const firstArr = cleaned.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);

  if (start === -1) {
    throw new Error("AI 返回内容中未找到 JSON");
  }

  const slice = cleaned.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    return JSON.parse(jsonrepair(slice));
  }
}

function isValidAiEntry(entry) {
  return !!entry
    && typeof entry.purpose === "string"
    && entry.purpose.trim().length > 0
    && typeof entry.riskSummary === "string"
    && entry.riskSummary.trim().length > 0
    && typeof entry.action === "string"
    && entry.action.trim().length > 0;
}

function looksTemplateLike(entry) {
  if (!entry) return true;
  const text = `${entry.purpose || ""}\n${entry.riskSummary || ""}`;
  return TEMPLATE_PATTERNS.some((keyword) => text.includes(keyword));
}

function getPathHeuristicExplanation(item) {
  const normalized = (item.path || "").replace(/\//g, "\\");
  const lower = normalized.toLowerCase();
  const name = normalized.split("\\").filter(Boolean).pop() || normalized;
  let purpose = `该路径「${name}」多用于程序运行或数据存放，需结合实际软件确认来源。`;
  if (lower.includes("\\windows")) {
    purpose = `该路径位于 Windows 系统目录（${name}），通常参与系统组件运行与语言资源加载。`;
  } else if (lower.includes("\\program files")) {
    purpose = `该路径位于 Program Files（${name}），通常用于安装应用程序与其运行组件。`;
  } else if (lower.includes("\\programdata")) {
    purpose = `该路径位于 ProgramData（${name}），常用于软件共享配置、缓存和许可证数据。`;
  } else if (lower.includes("\\users\\")) {
    purpose = `该路径位于用户数据区域（${name}），可能包含个人文件或应用用户态配置。`;
  } else if (lower.includes("\\appdata")) {
    purpose = `该路径位于 AppData（${name}），常用于应用缓存、配置和临时状态数据。`;
  }

  let riskSummary = "删除前建议确认是否仍被当前系统或业务软件使用，避免影响软件启动或功能完整性。";
  if (item.suggestion === "禁止删除") {
    riskSummary = "该条目风险较高，误删可能导致系统组件或软件功能异常，不建议直接清理。";
  } else if (item.suggestion === "建议删除") {
    riskSummary = "若确认是缓存、日志或可再生数据，通常可清理；建议先备份后再删除。";
  } else if (item.suggestion === "谨慎删除") {
    riskSummary = "该条目用途不够明确，可能影响用户数据或应用配置，建议先核对再处理。";
  }

  return {
    purpose,
    riskSummary,
    action: item.suggestion
  };
}

async function rewriteSingleItem(item, config) {
  const prompt = [
    "你是 Windows 路径分析助手。",
    "请只输出一个 JSON 对象，格式：{\"purpose\":\"...\",\"riskSummary\":\"...\",\"action\":\"...\"}。",
    "禁止出现以下措辞：命中规则库、规则建议为、请结合业务场景确认、未命中明确规则。",
    "purpose 必须结合该路径位置给出具体用途，不要空话；riskSummary 给出删除风险；action 只能是 建议删除/谨慎删除/禁止删除。",
    `路径: ${item.path}`,
    `类型: ${item.isDirectory ? "目录" : "文件"}`,
    `大小(bytes): ${item.size}`,
    `规则建议: ${item.suggestion}`,
    `规则原因: ${item.ruleReason}`
  ].join("\n");

  const response = await fetch(config.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "你擅长根据 Windows 目录层级判断路径用途与删除风险。"
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek 重写失败: ${response.status} ${raw.slice(0, 200)}`);
  }
  let apiData;
  try {
    apiData = JSON.parse(raw);
  } catch {
    apiData = JSON.parse(jsonrepair(raw));
  }
  const content = apiData?.choices?.[0]?.message?.content;
  const parsed = extractJsonObjectOrArray(content || "");
  return {
    purpose: parsed.purpose,
    riskSummary: parsed.riskSummary,
    action: parsed.action || item.suggestion
  };
}

async function explainBatch(batch, config) {
  const payloadItems = batch.map((item, idx) => ({
    id: idx,
    path: item.path,
    type: item.isDirectory ? "folder" : "file",
    sizeBytes: item.size,
    ruleSuggestion: item.suggestion,
    ruleReason: item.ruleReason
  }));

  const prompt = [
    "你是 Windows 磁盘清理专家，请根据输入路径判断真实用途并给出谨慎建议。",
    "只输出一个合法 JSON 对象，不要 markdown、不要代码围栏、不要多余说明。",
    "格式必须是：{\"results\":[{\"id\":0,\"purpose\":\"...\",\"riskSummary\":\"...\",\"action\":\"...\"}, ...]}",
    "字符串值内禁止使用英文双引号；如需强调请用中文引号「」。换行请用 \\n 转义。",
    "每个元素字段必须包含：id, purpose, riskSummary, action。",
    "要求：",
    "1) purpose 用一句话说明该路径常见用途，避免空话；",
    "2) riskSummary 说明删除风险与影响；",
    "3) action 只能是：建议删除 / 谨慎删除 / 禁止删除；",
    "4) 与 ruleSuggestion 冲突时，优先安全，不能激进。",
    `输入: ${JSON.stringify(payloadItems)}`
  ].join("\n");

  const response = await fetch(config.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "你擅长 Windows 文件系统、常见软件目录、缓存与系统关键目录识别。"
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek 请求失败: ${response.status} ${raw.slice(0, 240)}`);
  }

  let apiData;
  try {
    apiData = JSON.parse(raw);
  } catch {
    try {
      apiData = JSON.parse(jsonrepair(raw));
    } catch {
      throw new Error("DeepSeek 响应不是合法 JSON");
    }
  }

  const modelContent = apiData?.choices?.[0]?.message?.content;
  if (!modelContent) {
    throw new Error(`DeepSeek 模型「${config.model}」未返回可用内容，请切换到 deepseek-chat 重试`);
  }

  let parsed;
  try {
    parsed = extractJsonObjectOrArray(modelContent);
  } catch (primaryError) {
    throw new Error(`解析 AI 返回 JSON 失败: ${primaryError.message}`);
  }
  const items = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(items)) {
    throw new Error("DeepSeek 返回数据结构不正确");
  }

  const mapped = new Map();
  for (const entry of items) {
    mapped.set(Number(entry.id), {
      purpose: entry.purpose,
      riskSummary: entry.riskSummary,
      action: entry.action
    });
  }

  const missingIds = [];
  for (let idx = 0; idx < batch.length; idx += 1) {
    if (!isValidAiEntry(mapped.get(idx))) {
      missingIds.push(idx);
    }
  }
  if (missingIds.length > 0) {
    throw new Error(`DeepSeek 返回结果不完整，缺少 ${missingIds.length} 个条目`);
  }

  const lowQualityIds = [];
  for (let idx = 0; idx < batch.length; idx += 1) {
    if (looksTemplateLike(mapped.get(idx))) {
      lowQualityIds.push(idx);
    }
  }
  if (lowQualityIds.length > 0) {
    throw new Error(`DeepSeek 返回模板化内容，需重试 ${lowQualityIds.length} 个条目`);
  }

  return mapped;
}

async function explainBatchWithFallback(batch, config) {
  try {
    return await explainBatch(batch, config);
  } catch (error) {
    if (batch.length <= 1) {
      throw error;
    }
    const merged = new Map();
    for (let idx = 0; idx < batch.length; idx += 1) {
      const sub = await explainBatchWithFallback([batch[idx]], config);
      merged.set(idx, sub.get(0));
    }
    return merged;
  }
}

async function runWithConcurrency(tasks, concurrency, worker) {
  const result = new Array(tasks.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < tasks.length) {
      const current = cursor;
      cursor += 1;
      result[current] = await worker(tasks[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return result;
}

async function annotateItems(items, options = {}) {
  const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
  const model = options.model || DEFAULT_MODEL;
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const strict = options.strict !== false;
  const batchSize = Number(options.batchSize || 12);
  const batchConcurrency = Number(options.batchConcurrency || 2);
  const maxAiItemsInput = Number(options.maxAiItems);
  const maxAiItems = Number.isFinite(maxAiItemsInput) && maxAiItemsInput > 0 ? Math.floor(maxAiItemsInput) : items.length;

  if (!apiKey) {
    if (strict) {
      throw new Error("未提供 DeepSeek API Key，无法生成 AI 用途解释。");
    }
    return items.map((item) => ({ ...item, ...createRuleOnlyExplanation(item) }));
  }

  const aiItems = items.slice(0, maxAiItems);
  const ruleOnlyItems = items.slice(maxAiItems);
  const batches = [];
  for (let i = 0; i < aiItems.length; i += batchSize) {
    batches.push({
      start: i,
      batch: aiItems.slice(i, i + batchSize)
    });
  }

  const batchResults = await runWithConcurrency(batches, batchConcurrency, async ({ batch }) => {
    try {
      return await explainBatchWithFallback(batch, { apiKey, model, baseUrl });
    } catch (error) {
      if (strict) {
        throw error;
      }
      return new Map();
    }
  });

  const aiResult = [];
  for (let i = 0; i < batches.length; i += 1) {
    const { batch } = batches[i];
    const mapped = batchResults[i];
    for (let j = 0; j < batch.length; j += 1) {
      const current = batch[j];
      const ai = mapped.get(j);
      if (!isValidAiEntry(ai)) {
        if (strict) {
          throw new Error(`AI 解释缺失: ${current.path}`);
        }
        aiResult.push({
          ...current,
          ...createRuleOnlyExplanation(current)
        });
        continue;
      }
      let finalAi = ai;
      if (looksTemplateLike(finalAi)) {
        try {
          finalAi = await rewriteSingleItem(current, { apiKey, model, baseUrl });
        } catch {
          finalAi = getPathHeuristicExplanation(current);
        }
      }
      aiResult.push({
        ...current,
        ...finalAi
      });
    }
  }

  const ruleResult = ruleOnlyItems.map((item) => ({
    ...item,
    ...getPathHeuristicExplanation(item)
  }));
  const merged = [...aiResult, ...ruleResult].map((entry) => {
    if (looksTemplateLike(entry)) {
      return {
        ...entry,
        ...getPathHeuristicExplanation(entry)
      };
    }
    return entry;
  });

  return merged;
}

module.exports = { annotateItems };
