import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const TASKS_DIR = join(homedir(), "Tasks");
const PORT = 4000;

interface TaskInfo {
  task: string;
  branch?: string;
  status?: string;
  devPort?: number;
  url?: string;
  summary?: string;
  originalTask?: string;
  howToTest?: string[];
  screenshot?: string;
  figmaUrl?: string;
  figmaScreenshot?: string;
  completedAt?: string;
  agentLogTail?: string[];
  devServerStatus?: number | null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function pingPort(port: number): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.status;
  } catch {
    return null;
  }
}

async function getTaskInfo(taskName: string): Promise<TaskInfo> {
  const taskDir = join(TASKS_DIR, taskName);
  const info: TaskInfo = { task: taskName };

  // Read task.json
  const taskJsonStr = await readFileSafe(join(taskDir, "task.json"));
  if (taskJsonStr) {
    try {
      const taskJson = JSON.parse(taskJsonStr);
      Object.assign(info, taskJson);
    } catch {}
  }

  // Fallback summary from STATUS.md
  if (!info.summary) {
    const statusMd = await readFileSafe(join(taskDir, "STATUS.md"));
    if (statusMd) {
      const lines = statusMd.split("\n").filter((l) => l.trim());
      info.summary = lines.slice(0, 5).join("\n");
    }
  }

  // Read full agent.log
  const agentLog = await readFileSafe(join(taskDir, "agent.log"));
  if (agentLog) {
    const lines = agentLog.trim().split("\n");
    info.agentLogTail = lines;
  }

  // Check for screenshot
  if (await fileExists(join(taskDir, "screenshot.png"))) {
    info.screenshot = "screenshot.png";
  }

  // Detect figmaUrl from agent.log or STATUS.md if not in task.json
  if (!info.figmaUrl) {
    const figmaRegex = /https:\/\/www\.figma\.com\/[^\s)>"']*/;
    const sources = [agentLog, await readFileSafe(join(taskDir, "STATUS.md"))];
    for (const src of sources) {
      if (src) {
        const match = src.match(figmaRegex);
        if (match) {
          info.figmaUrl = match[0];
          break;
        }
      }
    }
  }

  // Check for figma screenshot
  if (await fileExists(join(taskDir, "figma-screenshot.png"))) {
    info.figmaScreenshot = "figma-screenshot.png";
  }

  // Ping devPort
  if (info.devPort) {
    info.devServerStatus = await pingPort(info.devPort);
  }

  return info;
}

async function getAllTasks(): Promise<TaskInfo[]> {
  try {
    const entries = await readdir(TASKS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    return Promise.all(dirs.map(getTaskInfo));
  } catch {
    return [];
  }
}

async function serveScreenshot(taskName: string): Promise<Response> {
  const filePath = join(TASKS_DIR, taskName, "screenshot.png");
  if (await fileExists(filePath)) {
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: { "Content-Type": "image/png" },
    });
  }
  return new Response("Not found", { status: 404 });
}

async function serveFigmaScreenshot(taskName: string): Promise<Response> {
  const filePath = join(TASKS_DIR, taskName, "figma-screenshot.png");
  if (await fileExists(filePath)) {
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: { "Content-Type": "image/png" },
    });
  }
  return new Response("Not found", { status: 404 });
}

async function serveHTML(): Promise<Response> {
  const htmlPath = join(import.meta.dir, "index.html");
  const html = await readFile(htmlPath, "utf-8");
  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/tasks") {
      const tasks = await getAllTasks();
      return Response.json(tasks);
    }

    if (url.pathname.startsWith("/screenshots/")) {
      const taskName = url.pathname.replace("/screenshots/", "");
      return serveScreenshot(taskName);
    }

    if (url.pathname.startsWith("/figma-screenshots/")) {
      const taskName = url.pathname.replace("/figma-screenshots/", "");
      return serveFigmaScreenshot(taskName);
    }

    if (url.pathname === "/") {
      return serveHTML();
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Tasks Dashboard running at http://localhost:${PORT}`);
