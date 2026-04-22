function bytesToReadable(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "-";
  }
  if (bytes === 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(2)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function riskLabel(risk) {
  if (risk === "safe") return "建议删除";
  if (risk === "forbidden") return "禁止删除";
  return "谨慎删除";
}

function riskClass(risk) {
  if (risk === "safe") return "safe";
  if (risk === "forbidden") return "forbidden";
  return "caution";
}

async function runScan() {
  const button = document.getElementById("scan-btn");
  const status = document.getElementById("status");
  const drive = document.getElementById("drive").value;
  const aiApiKeyInput = document.getElementById("ai-api-key");
  const aiModelInput = document.getElementById("ai-model");
  const aiApiKey = (aiApiKeyInput?.value || "").trim();
  const aiModel = (aiModelInput?.value || "deepseek-chat").trim();

  if (!aiApiKey) {
    status.className = "status error";
    status.textContent = "请先输入 DeepSeek API Key。";
    return;
  }

  button.disabled = true;
  status.className = "status";
  status.textContent = `正在扫描 ${drive}: 盘并调用 ${aiModel} 生成解释，请稍候...`;

  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        drive,
        aiApiKey,
        aiModel
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "扫描失败");
    }

    status.className = "status ok";
    status.textContent = "扫描完成，正在跳转到报告页...";
    localStorage.setItem("cdelete.aiApiKey", aiApiKey);
    localStorage.setItem("cdelete.aiModel", aiModel);
    window.location.href = `/report.html?id=${encodeURIComponent(data.id)}`;
  } catch (error) {
    status.className = "status error";
    status.textContent = error.message;
    button.disabled = false;
  }
}

async function loadReport() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (!id) {
    return;
  }

  const response = await fetch(`/api/report/${encodeURIComponent(id)}`);
  const data = await response.json();
  if (!response.ok) {
    document.getElementById("meta").textContent = data.error || "报告不存在";
    return;
  }

  document.getElementById("meta").textContent = `盘符：${data.drive} | 扫描时间：${new Date(data.scannedAt).toLocaleString()} | 扫描节点：${data.scannedNodeCount}`;
  document.getElementById("reclaim").textContent = `${data.stats.estimatedReclaimGB} GB`;
  document.getElementById("safe-count").textContent = data.stats.safeCount;
  document.getElementById("forbidden-count").textContent = data.stats.forbiddenCount;

  const body = document.getElementById("report-body");
  body.innerHTML = "";

  data.items.slice(0, 200).forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.path}</td>
      <td>${bytesToReadable(item.size)}</td>
      <td><span class="tag ${riskClass(item.risk)}">${riskLabel(item.risk)}</span></td>
      <td>${item.action || item.suggestion}</td>
      <td>${item.purpose || "-"}</td>
      <td>${item.riskSummary || item.ruleReason || "-"}</td>
    `;
    body.appendChild(tr);
  });
}

function bindEvents() {
  const scanButton = document.getElementById("scan-btn");
  const aiApiKeyInput = document.getElementById("ai-api-key");
  const aiModelInput = document.getElementById("ai-model");

  if (aiApiKeyInput) {
    aiApiKeyInput.value = localStorage.getItem("cdelete.aiApiKey") || "";
  }
  if (aiModelInput) {
    aiModelInput.value = localStorage.getItem("cdelete.aiModel") || "deepseek-chat";
  }
  if (scanButton) {
    scanButton.addEventListener("click", runScan);
  }
}

bindEvents();
loadReport();
