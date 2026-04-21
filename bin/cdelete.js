#!/usr/bin/env node

const { startServer } = require("../src/server");

startServer({
  shouldOpenBrowser: true
}).catch((error) => {
  console.error("CDelete 启动失败:", error.message);
  process.exit(1);
});
