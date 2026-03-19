import { readdir, readFile, writeFile, stat, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { existsSync } from "fs";

const TASKS_DIR = join(homedir(), "Tasks");
const SUGGESTIONS_FILE = join(TASKS_DIR, "suggestions.json");
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

function truncateStr(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.substring(0, maxLen) + "...";
}

function toolInputSummary(
  name: string,
  input: Record<string, unknown>
): string {
  if (!input) return "";
  switch (name) {
    case "Bash":
      return truncateStr(String(input.command || ""), 80);
    case "Read":
    case "Edit":
    case "Write":
      return String(input.file_path || "");
    case "Grep":
      return `/${input.pattern || ""}/ in ${input.path || "."}`;
    case "Glob":
      return String(input.pattern || "");
    case "Agent":
      return String(input.description || "");
    case "TodoWrite":
      return `${(Array.isArray(input.todos) ? input.todos : []).length} tasks`;
    default:
      return truncateStr(JSON.stringify(input), 60);
  }
}

function parseAgentLog(raw: string): string {
  const lines = raw.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      output.push(trimmed);
      continue;
    }

    if (obj.type === "assistant") {
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg?.content as
        | Array<Record<string, unknown>>
        | undefined;
      if (!content) continue;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          const text = String(block.text).trim();
          if (text) output.push(text);
        } else if (block.type === "tool_use") {
          const name = String(block.name || "Unknown");
          const summary = toolInputSummary(
            name,
            block.input as Record<string, unknown>
          );
          output.push(`\u{1F527} ${name}: ${summary}`);
        }
      }
    } else if (obj.type === "user") {
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg?.content as
        | Array<Record<string, unknown>>
        | undefined;
      if (!content) continue;
      for (const block of content) {
        if (block.type === "tool_result") {
          if (block.is_error) {
            output.push("\u274C Error");
          } else {
            output.push("\u2705 Done");
          }
        }
      }
    }
  }

  return output.join("\n");
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
  // Always use directory name for task (task.json may override with a description)
  info.task = taskName;

  if (!info.summary) {
    const statusMd = await readFileSafe(join(taskDir, "STATUS.md"));
    if (statusMd) {
      const lines = statusMd.split("\n").filter((l) => l.trim());
      info.summary = lines.slice(0, 5).join("\n");
    }
  }

  const agentLogContent = await readFileSafe(join(taskDir, "agent.log"));
  if (agentLogContent) {
    info.agentLog = parseAgentLog(agentLogContent);
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

interface Suggestion {
  id: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  priority: "high" | "medium" | "low";
  suggestedBy: string;
  createdAt: string;
}

type SuggestionsData = Record<string, Suggestion[]>;

async function readSuggestions(): Promise<SuggestionsData> {
  const raw = await readFileSafe(SUGGESTIONS_FILE);
  if (!raw) return { dashboard: [] };
  try {
    const data = JSON.parse(raw) as SuggestionsData;
    // Map 'general' suggestions to 'dashboard' project
    if (data.general) {
      data.dashboard = [...(data.dashboard || []), ...data.general];
      delete data.general;
    }
    if (!data.dashboard) data.dashboard = [];
    return data;
  } catch {
    return { dashboard: [] };
  }
}

async function writeSuggestions(data: SuggestionsData): Promise<void> {
  await writeFile(SUGGESTIONS_FILE, JSON.stringify(data, null, 2));
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

    if (url.pathname === "/api/suggestions") {
      const data = await readSuggestions();
      return Response.json(data);
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/suggestions/")) {
      const project = decodeURIComponent(url.pathname.replace("/api/suggestions/", ""));
      if (!project) return new Response("Missing project", { status: 400 });
      const body = await req.json() as { title?: string; description?: string; priority?: string };
      if (!body.title) return new Response("Missing title", { status: 400 });
      const data = await readSuggestions();
      if (!data[project]) data[project] = [];
      const suggestion: Suggestion = {
        id: `${project}-${Date.now()}`,
        title: body.title,
        description: body.description || "",
        status: "pending",
        priority: (body.priority as Suggestion["priority"]) || "medium",
        suggestedBy: "claw",
        createdAt: new Date().toISOString(),
      };
      data[project].push(suggestion);
      await writeSuggestions(data);
      return Response.json(suggestion, { status: 201 });
    }

    if (req.method === "PATCH" && url.pathname.match(/^\/api\/suggestions\/[^/]+\/[^/]+$/)) {
      const parts = url.pathname.replace("/api/suggestions/", "").split("/");
      const project = decodeURIComponent(parts[0]);
      const id = decodeURIComponent(parts[1]);
      const body = await req.json() as { status?: string };
      if (!body.status || !["approved", "rejected"].includes(body.status)) {
        return new Response("Invalid status", { status: 400 });
      }
      const data = await readSuggestions();
      const list = data[project];
      if (!list) return new Response("Project not found", { status: 404 });
      const item = list.find((s) => s.id === id);
      if (!item) return new Response("Suggestion not found", { status: 404 });
      item.status = body.status as Suggestion["status"];
      await writeSuggestions(data);
      return Response.json(item);
    }

    if (req.method === "POST" && url.pathname === "/api/spawn-agent") {
      try {
        const body = (await req.json()) as {
          project: string;
          id: string;
          title: string;
          description: string;
        };
        if (!body.project || !body.title) {
          return new Response("Missing project or title", { status: 400 });
        }

        const slugified = body.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 20)
          .replace(/-$/, "");
        const projectDir = join(homedir(), "Projects", body.project);
        const worktreePath = join(homedir(), "Tasks", `${body.project}-${slugified}`);
        const sessionName = `wf-${slugified}`;

        // Ensure ~/Tasks exists
        if (!existsSync(join(homedir(), "Tasks"))) {
          await mkdir(join(homedir(), "Tasks"), { recursive: true });
        }

        // Create worktree
        await runCommand("git", [
          "-C",
          projectDir,
          "worktree",
          "add",
          worktreePath,
          "-b",
          `agent/${slugified}`,
          "main",
        ]);

        // Install deps if src/package.json exists
        const srcDir = join(worktreePath, "src");
        if (existsSync(join(srcDir, "package.json"))) {
          await runCommand("bun", [
            "install",
            "--frozen-lockfile",
            `--cwd=${srcDir}`,
          ]);
        }

        // Write wrapper script
        const scriptPath = `/tmp/run-${body.project}-${slugified}.sh`;
        const prompt = `${body.title}\n\n${body.description}`.replace(
          /'/g,
          "'\\''"
        );
        const scriptContent = `#!/bin/bash
cd "${worktreePath}/src" 2>/dev/null || cd "${worktreePath}"
claude --dangerously-skip-permissions -p '${prompt}'
echo "\\n--- Agent finished. Press Enter to close ---"
read
`;
        await writeFile(scriptPath, scriptContent, { mode: 0o755 });

        // Start tmux session
        await runCommand("tmux", [
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-c",
          existsSync(srcDir) ? srcDir : worktreePath,
          `bash ${scriptPath}`,
        ]);

        return Response.json({
          success: true,
          session: sessionName,
          worktree: worktreePath,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { success: false, error: message },
          { status: 500 }
        );
      }
    }

    if (url.pathname === "/api/projects") {
      const projectsDir = join(homedir(), "Projects");
      try {
        const entries = await readdir(projectsDir, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name);
        return Response.json(dirs);
      } catch {
        return Response.json([]);
      }
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
