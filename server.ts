import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

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
  agentLog?: string;
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

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `exit code ${code}`));
    });
  });
}

async function getTaskInfo(taskName: string): Promise<TaskInfo> {
  const taskDir = join(TASKS_DIR, taskName);
  const info: TaskInfo = { task: taskName };

  const taskJsonStr = await readFileSafe(join(taskDir, "task.json"));
  if (taskJsonStr) {
    try {
      Object.assign(info, JSON.parse(taskJsonStr));
    } catch {}
  }

  if (!info.summary) {
    const statusMd = await readFileSafe(join(taskDir, "STATUS.md"));
    if (statusMd) {
      const lines = statusMd.split("\n").filter((l) => l.trim());
      info.summary = lines.slice(0, 5).join("\n");
    }
  }

  const agentLogContent = await readFileSafe(join(taskDir, "agent.log"));
  if (agentLogContent) {
    info.agentLog = agentLogContent.trim();
  }

  if (await fileExists(join(taskDir, "screenshot.png"))) {
    info.screenshot = "screenshot.png";
  }

  if (!info.figmaUrl) {
    const figmaRegex = /https:\/\/www\.figma\.com\/[^\s)>"']*/;
    const sources = [
      agentLogContent,
      taskJsonStr,
      await readFileSafe(join(taskDir, "STATUS.md")),
    ];
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

  if (await fileExists(join(taskDir, "figma-screenshot.png"))) {
    info.figmaScreenshot = "figma-screenshot.png";
  }

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
    return new Response(Bun.file(filePath), {
      headers: { "Content-Type": "image/png" },
    });
  }
  return new Response("Not found", { status: 404 });
}

async function serveFigmaScreenshot(taskName: string): Promise<Response> {
  const filePath = join(TASKS_DIR, taskName, "figma-screenshot.png");
  if (await fileExists(filePath)) {
    return new Response(Bun.file(filePath), {
      headers: { "Content-Type": "image/png" },
    });
  }
  return new Response("Not found", { status: 404 });
}

async function getTmuxSessions(): Promise<string[]> {
  try {
    const out = await runCommand("tmux", ["ls", "-F", "#{session_name}"]);
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function tmuxSessionExists(session: string): Promise<boolean> {
  try {
    await runCommand("tmux", ["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

function streamTmuxSession(session: string): Response {
  let intervalId: ReturnType<typeof setInterval>;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          cleanup();
        }
      };

      const capture = async () => {
        try {
          if (!(await tmuxSessionExists(session))) {
            send(JSON.stringify({ done: true }));
            cleanup();
            return;
          }
          const output = await runCommand("tmux", [
            "capture-pane",
            "-t",
            session,
            "-p",
          ]);
          send(JSON.stringify({ output }));
        } catch {
          send(JSON.stringify({ done: true }));
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(intervalId);
        try {
          controller.close();
        } catch {}
      };

      capture();
      intervalId = setInterval(capture, 1000);
    },
    cancel() {
      closed = true;
      clearInterval(intervalId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
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

    if (url.pathname === "/api/tmux-sessions") {
      const sessions = await getTmuxSessions();
      return Response.json(sessions);
    }

    if (url.pathname.startsWith("/api/tmux/")) {
      const session = decodeURIComponent(
        url.pathname.replace("/api/tmux/", "")
      );
      if (!session) return new Response("Missing session", { status: 400 });
      if (!(await tmuxSessionExists(session))) {
        return new Response(
          `data: ${JSON.stringify({ done: true })}\n\n`,
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          }
        );
      }
      return streamTmuxSession(session);
    }

    if (url.pathname.startsWith("/screenshots/")) {
      const taskName = decodeURIComponent(
        url.pathname.replace("/screenshots/", "")
      );
      return serveScreenshot(taskName);
    }

    if (url.pathname.startsWith("/figma-screenshots/")) {
      const taskName = decodeURIComponent(
        url.pathname.replace("/figma-screenshots/", "")
      );
      return serveFigmaScreenshot(taskName);
    }

    if (url.pathname === "/") {
      const html = await readFile(join(import.meta.dir, "index.html"), "utf-8");
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Tasks Dashboard running at http://localhost:${PORT}`);
