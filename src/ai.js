const { jsonrepair } = require("jsonrepair");

const DEFAULT_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-reasoner";

function createRuleOnlyExplanation(item) {
  const suffix = item.isDirectory ? "目录" : "文件";
  return {
    purpose: `该${suffix}命中规则库：${item.ruleReason}`,
    riskSummary: `规则建议为「${item.suggestion}」，请结合业务场景确认。`,
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
      max_tokens: 1200,
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
    throw new Error("DeepSeek 未返回可用内容");
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
  const maxAiItems = Number(options.maxAiItems || 80);

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
      const ai = mapped.get(j) || createRuleOnlyExplanation(current);
      aiResult.push({
        ...current,
        ...ai
      });
    }
  }

  const ruleResult = ruleOnlyItems.map((item) => ({
    ...item,
    ...createRuleOnlyExplanation(item)
  }));

  return [...aiResult, ...ruleResult];
}

module.exports = { annotateItems };
