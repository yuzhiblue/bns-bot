#!/usr/bin/env node
// bns-bot 启动/停止/状态控制
// 用法:
//   node control.js start      后台启动 bot(不占窗口)
//   node control.js stop       停止 bot
//   node control.js status     查看状态 + 最后日志
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PID_FILE = path.join(ROOT, "bot.pid");
const LOG_FILE = path.join(ROOT, "bot.log");

function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10); } catch { return null; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const cmd = process.argv[2];

if (cmd === "start") {
  const pid = readPid();
  if (pid && pidAlive(pid)) {
    console.log(`[ALREADY RUNNING] pid=${pid}`);
    console.log(fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-15).join("\n"));
    process.exit(0);
  }
  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "bot.js")], {
    cwd: ROOT,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(`[OK] started, pid=${child.pid}`);
  setTimeout(() => process.exit(0), 500);
} else if (cmd === "stop") {
  const pid = readPid();
  if (pid && pidAlive(pid)) {
    process.kill(pid, "SIGINT");
    console.log(`[OK] stopped pid=${pid}`);
  } else {
    console.log("no running instance");
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
} else if (cmd === "status") {
  const pid = readPid();
  const alive = pid && pidAlive(pid);
  console.log(`bot: ${alive ? "running pid=" + pid : "stopped"}`);
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
    console.log("--- last 20 lines ---");
    console.log(lines.slice(-20).join("\n"));
  } catch { console.log("(no log yet)"); }
} else {
  console.log("usage: node control.js [start|stop|status]");
}
