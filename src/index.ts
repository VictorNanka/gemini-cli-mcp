import fs from "node:fs"
import { spawn } from "node:child_process"
import { version } from "../package.json"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import z from "zod"

const server = new McpServer(
  {
    name: "gemini-cli-mcp",
    version,
  },
  {
    capabilities: {
      logging: {},
    },
  }
)

interface GeminiStreamEvent {
  type: string
  // init event
  session_id?: string
  timestamp?: string
  model?: string
  // message event
  role?: string
  content?: string
  delta?: boolean
  // result event
  status?: string
  stats?: {
    total_tokens?: number
    input_tokens?: number
    output_tokens?: number
    duration_ms?: number
    tool_calls?: number
  }
  total_cost_usd?: number
}

async function runGeminiCLI(
  task: string,
  cwd: string,
  historyId?: string
): Promise<{ result: string; session_id?: string; total_cost_usd?: number }> {
  const args = ["-p", task, "--output-format", "stream-json"]

  if (historyId) {
    args.push("--history-id", historyId)
  }

  // Hardcoded allowed tools for gemini-cli
  const allowedTools = [
    "read_file",
    "write_file",
    "edit",
    "run_shell_command",
    "web_fetch",
    "google_web_search",
    "save_memory",
    "write_todos",
  ]
  args.push("--allowed-tools", allowedTools.join(","))

  return new Promise((resolve, reject) => {
    const gemini = spawn("gemini", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let assistantContent = ""
    let sessionId: string | undefined
    let totalCostUsd: number | undefined

    gemini.stdout.on("data", (data) => {
      const chunk = data.toString()
      stdout += chunk

      // Process newline-delimited JSON events
      const lines = chunk.split("\n").filter((line: string) => line.trim())
      for (const line of lines) {
        try {
          const event: GeminiStreamEvent = JSON.parse(line)

          server.sendLoggingMessage({
            level: "info",
            data: `${line}`,
          })

          if (event.type === "init" && event.session_id) {
            sessionId = event.session_id
          } else if (event.type === "message" && event.role === "assistant" && event.content) {
            assistantContent += event.content
          } else if (event.type === "result") {
            if (event.total_cost_usd !== undefined) {
              totalCostUsd = event.total_cost_usd
            }
          }
        } catch (e) {
          // Ignore JSON parse errors for partial lines
        }
      }
    })

    gemini.stderr.on("data", (data) => {
      stderr += data.toString()
      server.sendLoggingMessage({
        level: "error",
        data: data.toString(),
      })
    })

    gemini.on("close", (code) => {
      if (code === 0) {
        resolve({
          result: assistantContent || stdout,
          session_id: sessionId,
          total_cost_usd: totalCostUsd,
        })
      } else {
        reject(
          new Error(`Gemini CLI exited with code ${code}. Error: ${stderr}`)
        )
      }
    })

    gemini.on("error", (error) => {
      reject(new Error(`Failed to spawn Gemini CLI: ${error.message}`))
    })
  })
}

server.registerTool(
  "task",
  {
    title: "New task",
    description: "Run Gemini CLI agent to complete a task",
    inputSchema: {
      task: z
        .string()
        .describe("The task to delegate, keep it close to original user query"),
      cwd: z
        .string()
        .describe(
          "The working directory to run the Gemini CLI, must be an absolute path"
        ),
      historyId: z
        .string()
        .optional()
        .describe("Continue from a previous session (session_id from previous response)"),
    },
  },
  async ({ task, cwd, historyId }) => {
    if (!fs.existsSync(cwd)) {
      throw new Error(`Directory ${cwd} does not exist`)
    }

    try {
      const result = await runGeminiCLI(task, cwd, historyId)

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        _meta: {
          chatwise: {
            // do not submit again since we can just display the response directly
            stop: true,
            // the markdown to display after the tool result
            markdown: result.result || "",
          },
        },
      }
    } catch (error) {
      throw new Error(
        `Failed to run Gemini CLI: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
