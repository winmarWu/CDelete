const path = require("path");
const express = require("express");
const { exec } = require("child_process");
const { scanDrive } = require("./scanner");

const DEFAULT_PORT = Number(process.env.CDELETE_PORT || 3456);
const reports = new Map();

function openBrowser(url) {
  const command = process.platform === "win32" ? `start "" "${url}"` : `open "${url}"`;
  exec(command);
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      service: "CDelete",
      now: new Date().toISOString()
    });
  });

  app.post("/api/scan", async (req, res) => {
    const rawDrive = (req.body?.drive || "C").toString().replace(":", "").toUpperCase();
    const aiApiKey = (req.body?.aiApiKey || "").toString().trim();
    const aiModel = (req.body?.aiModel || process.env.DEEPSEEK_MODEL || "deepseek-chat").toString().trim();
    if (!["C", "D"].includes(rawDrive)) {
      return res.status(400).json({ error: "当前仅支持 C 或 D 盘扫描。" });
    }
    if (!aiApiKey && !process.env.DEEPSEEK_API_KEY) {
      return res.status(400).json({ error: "请提供 DeepSeek API Key，当前版本会强制调用大模型生成解释。" });
    }

    try {
      const report = await scanDrive(rawDrive, {
        aiApiKey,
        aiModel,
        aiStrict: true,
        aiBatchSize: Number(req.body?.aiBatchSize || process.env.CDELETE_AI_BATCH_SIZE || 16),
        aiBatchConcurrency: Number(req.body?.aiBatchConcurrency || process.env.CDELETE_AI_BATCH_CONCURRENCY || 3),
        maxAiItems: Number(req.body?.maxAiItems || process.env.CDELETE_AI_MAX_ITEMS || 80)
      });
      reports.set(report.id, report);
      return res.json({
        id: report.id,
        drive: report.drive,
        scannedAt: report.scannedAt
      });
    } catch (error) {
      return res.status(500).json({
        error: error.message || "扫描失败"
      });
    }
  });

  app.get("/api/report/:id", (req, res) => {
    const report = reports.get(req.params.id);
    if (!report) {
      return res.status(404).json({ error: "报告不存在，请重新扫描。" });
    }
    return res.json(report);
  });

  return app;
}

async function startServer(options = {}) {
  const port = Number(options.port || DEFAULT_PORT);
  const app = createApp();
  const url = `http://127.0.0.1:${port}`;

  await new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`CDelete 已启动: ${url}`);
      console.log("请在浏览器中选择盘符并开始扫描。");
      resolve();
    });
  });

  if (options.shouldOpenBrowser) {
    openBrowser(url);
  }
}

if (require.main === module) {
  startServer({
    shouldOpenBrowser: false
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
  createApp
};
