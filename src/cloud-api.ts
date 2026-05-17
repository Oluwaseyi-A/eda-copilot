#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { join, normalize, sep } from "path";
import { promisify } from "util";
import { AllowedAction, planIntent, PlannerDecision } from "./planner.js";

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface JobRecord {
  id: string;
  correlationId: string;
  sessionId: string;
  type: AllowedAction;
  input: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  artifactPaths: string[];
  summary?: string;
  plannerDecision?: PlannerDecision;
}

const jobs = new Map<string, JobRecord>();
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const execFileAsync = promisify(execFile);
const jobStorageRoot = join(process.cwd(), ".eda-copilot", "jobs");

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  correlationId: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "x-correlation-id": correlationId,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-session-id,x-correlation-id",
  });
  response.end(JSON.stringify(body, null, 2));
}

async function sendStaticFile(response: ServerResponse, filePath: string, contentType: string): Promise<void> {
  const content = await fs.readFile(filePath, "utf8");
  response.writeHead(200, { "content-type": contentType });
  response.end(content);
}

function getClientKey(request: IncomingMessage): string {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  return request.socket.remoteAddress || "unknown";
}

function isRateLimited(request: IncomingMessage): boolean {
  const key = getClientKey(request);
  const now = Date.now();
  const current = rateLimits.get(key);

  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  current.count += 1;
  return current.count > RATE_LIMIT_MAX;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function stringField(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {},
): string {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error(`Missing required field: ${key}`);
    }
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`Field '${key}' must be a string.`);
  }
  if (options.maxLength && value.length > options.maxLength) {
    throw new Error(`Field '${key}' exceeds ${options.maxLength} characters.`);
  }
  return value;
}

function createJob(
  type: AllowedAction,
  input: string,
  sessionId: string,
  correlationId: string,
  plannerDecision?: PlannerDecision,
): JobRecord {
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: randomUUID(),
    correlationId,
    sessionId,
    type,
    input,
    status: "queued",
    createdAt: now,
    artifactPaths: [],
    plannerDecision,
  };

  jobs.set(job.id, job);
  queueJobExecution(job.id);
  return job;
}

function buildJobInput(message: string, decision: PlannerDecision): string {
  const generatedVerilog = decision.parameters.verilogCode?.trim();
  if (!generatedVerilog) {
    return message;
  }

  return [
    message,
    "",
    "```verilog",
    generatedVerilog,
    "```",
  ].join("\n");
}

function queueJobExecution(jobId: string): void {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (!job || job.status !== "queued") return;
    job.status = "running";
    job.startedAt = new Date().toISOString();

    executeJob(job).catch((error: unknown) => {
      const current = jobs.get(jobId);
      if (!current) return;
      current.status = "failed";
      current.finishedAt = new Date().toISOString();
      current.errorMessage = error instanceof Error ? error.message : String(error);
      current.summary = `Job failed: ${current.errorMessage}`;
    });
  }, 350);
}

async function executeJob(job: JobRecord): Promise<void> {
  if (job.type === "synthesize_verilog") {
    await executeSynthesisJob(job);
    return;
  }

  if (job.type === "run_openlane_flow") {
    await executeOpenLaneJob(job);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 1_250));
  if (job.status === "cancelled") return;

  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  job.artifactPaths = [
    `jobs/${job.id}/input/request.txt`,
    `jobs/${job.id}/logs/${job.type}.log`,
    `jobs/${job.id}/artifacts/result.json`,
  ];
  job.summary = buildMockSummary(job);
}

async function executeSynthesisJob(job: JobRecord): Promise<void> {
  const verilogCode = extractVerilog(job.input);
  const topModule = inferTopModule(verilogCode);
  const jobDir = join(jobStorageRoot, job.id);
  const inputDir = join(jobDir, "input");
  const logsDir = join(jobDir, "logs");
  const artifactsDir = join(jobDir, "artifacts");
  const designPath = join(inputDir, "design.v");
  const scriptPath = join(inputDir, "synth.ys");
  const logPath = join(logsDir, "yosys.log");
  const netlistPath = join(artifactsDir, "synth_output.v");
  const resultPath = join(artifactsDir, "result.json");

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(designPath, verilogCode);
  await fs.writeFile(scriptPath, [
    "read_verilog design.v",
    `hierarchy -check -top ${topModule}`,
    "proc",
    "opt",
    `synth -top ${topModule}`,
    "stat",
    "write_verilog ../artifacts/synth_output.v",
    "",
  ].join("\n"));

  try {
    const { stdout, stderr } = await execFileAsync("yosys", ["-s", "synth.ys"], {
      cwd: inputDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const log = [stdout, stderr].filter(Boolean).join("\n");
    await fs.writeFile(logPath, log);

    const metrics = parseYosysMetrics(log);
    const result = {
      jobId: job.id,
      type: job.type,
      topModule,
      status: "completed",
      metrics,
      artifacts: {
        input: `jobs/${job.id}/input/design.v`,
        log: `jobs/${job.id}/logs/yosys.log`,
        netlist: `jobs/${job.id}/artifacts/synth_output.v`,
        result: `jobs/${job.id}/artifacts/result.json`,
      },
    };
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));

    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.artifactPaths = [
      result.artifacts.input,
      result.artifacts.log,
      result.artifacts.netlist,
      result.artifacts.result,
    ];
    job.summary = await summarizeSynthesisResult(topModule, metrics, log, job.plannerDecision);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    const result = {
      jobId: job.id,
      type: job.type,
      topModule,
      status: "completed_with_mock",
      note: "Yosys is not installed in this environment, so the API returned a mock synthesis result.",
    };
    await fs.writeFile(logPath, "Yosys executable was not found on PATH.\n");
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));

    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.artifactPaths = [
      `jobs/${job.id}/input/design.v`,
      `jobs/${job.id}/logs/yosys.log`,
      `jobs/${job.id}/artifacts/result.json`,
    ];
    job.summary = formatSynthesisSummary(topModule, {}, true);
  }
}

function buildMockSummary(job: JobRecord): string {
  switch (job.type) {
    case "synthesize_verilog":
      return "Mock Yosys synthesis completed. Next step: wire this job to the worker container and store real logs in Cloud Storage.";
    case "simulate_verilog":
      return "Mock Icarus Verilog simulation completed. A real worker should capture stdout, stderr, and VCD artifacts.";
    case "summarize_report":
      return "Mock report summary created with timing, area, and warning sections ready for an LLM summarizer.";
    case "run_openlane_flow":
      return "OpenLane flow completed.";
  }
}

async function executeOpenLaneJob(job: JobRecord): Promise<void> {
  const originalVerilogCode = extractVerilog(job.input);
  const prepared = await prepareOpenLaneVerilog(originalVerilogCode, job.input, job.plannerDecision);
  const verilogCode = prepared.verilogCode;
  const topModule = inferTopModule(verilogCode);
  const jobDir = join(jobStorageRoot, job.id);
  const inputDir = join(jobDir, "input");
  const logsDir = join(jobDir, "logs");
  const reportsDir = join(jobDir, "reports");
  const artifactsDir = join(jobDir, "artifacts");
  const designPath = join(inputDir, `${topModule}.v`);
  const configPath = join(inputDir, "config.json");
  const logPath = join(logsDir, "openlane.log");
  const resultPath = join(artifactsDir, "result.json");

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(designPath, verilogCode);
  await fs.writeFile(configPath, JSON.stringify({
    DESIGN_NAME: topModule,
    VERILOG_FILES: `dir::${topModule}.v`,
    CLOCK_PORT: "clk",
    CLOCK_PERIOD: 10,
    FP_SIZING: "absolute",
    DIE_AREA: "0 0 300 300",
    CORE_AREA: "20 20 280 280",
    PL_BASIC_PLACEMENT: true,
    PL_TARGET_DENSITY: 0.2,
    RUN_KLAYOUT: false,
    RUN_KLAYOUT_DRC: false,
    RUN_KLAYOUT_XOR: false,
    RUN_MAGIC_DRC: false,
    RUN_LVS: false,
    QUIT_ON_TIMING_VIOLATIONS: false,
    QUIT_ON_MAGIC_DRC: false,
    QUIT_ON_LVS_ERROR: false,
  }, null, 2));

  try {
    const { stdout, stderr } = await execFileAsync("flow.tcl", ["-design", inputDir, "-tag", "run", "-overwrite"], {
      cwd: inputDir,
      timeout: Number(process.env.OPENLANE_TIMEOUT_MS || 1_200_000),
      maxBuffer: 30 * 1024 * 1024,
      env: {
        ...process.env,
        PDK: process.env.PDK || "sky130A",
        STD_CELL_LIBRARY: process.env.STD_CELL_LIBRARY || "sky130_fd_sc_hd",
      },
    });
    const log = [stdout, stderr].filter(Boolean).join("\n");
    await fs.writeFile(logPath, log);

    const copiedArtifacts = await collectOpenLaneArtifacts(inputDir, job.id, artifactsDir, reportsDir);
    const result = {
      jobId: job.id,
      type: job.type,
      topModule,
      status: "completed",
      note: prepared.note || "Real OpenLane flow executed in the Cloud Run container.",
      artifacts: copiedArtifacts,
    };
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));

    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.artifactPaths = [
      `jobs/${job.id}/input/${topModule}.v`,
      `jobs/${job.id}/input/config.json`,
      `jobs/${job.id}/logs/openlane.log`,
      ...copiedArtifacts,
      `jobs/${job.id}/artifacts/result.json`,
    ];
    job.summary = `Real OpenLane flow completed for ${topModule}. ${prepared.summarySuffix}Review openlane.log and generated artifacts for flow details.`;
  } catch (error: any) {
    const errorText = error?.message || String(error);
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    await fs.writeFile(logPath, [stdout, stderr, errorText].filter(Boolean).join("\n"));
    await fs.writeFile(resultPath, JSON.stringify({
      jobId: job.id,
      type: job.type,
      topModule,
      status: "failed",
      error: errorText,
      note: "Real OpenLane execution was attempted. See openlane.log for the toolchain or design error.",
    }, null, 2));

    job.artifactPaths = [
      `jobs/${job.id}/input/${topModule}.v`,
      `jobs/${job.id}/input/config.json`,
      `jobs/${job.id}/logs/openlane.log`,
      `jobs/${job.id}/artifacts/result.json`,
    ];
    throw new Error(`OpenLane flow failed for ${topModule}. See openlane.log.`);
  }
}

async function prepareOpenLaneVerilog(
  verilogCode: string,
  originalInput: string,
  plannerDecision?: PlannerDecision,
): Promise<{ verilogCode: string; note?: string; summarySuffix: string }> {
  const plannerVerilog = plannerDecision?.parameters.verilogCode?.trim();
  const candidate = plannerVerilog || verilogCode;

  if (!needsRtlCompletion(candidate)) {
    return { verilogCode: candidate, summarySuffix: "" };
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("The provided RTL is an empty or placeholder module. Configure OPENAI_API_KEY so the LLM can complete it before OpenLane.");
  }

  const completed = await completeRtlWithOpenAI(candidate, originalInput);
  if (needsRtlCompletion(completed)) {
    throw new Error("The LLM returned RTL that still appears to be an empty or placeholder module.");
  }

  return {
    verilogCode: completed,
    note: "Real OpenLane flow executed after the LLM completed placeholder RTL into synthesizable Verilog.",
    summarySuffix: "The input RTL skeleton was completed by the LLM before execution. ",
  };
}

function needsRtlCompletion(verilogCode: string): boolean {
  const lowered = verilogCode.toLowerCase();
  if (/your\s+rtl\s+design\s+here|todo|placeholder/.test(lowered)) {
    return true;
  }

  const bodyMatch = verilogCode.match(/\bmodule\b[\s\S]*?\);\s*([\s\S]*?)\bendmodule\b/i);
  const body = bodyMatch?.[1] || "";
  const bodyWithoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim();

  if (!bodyWithoutComments) {
    return true;
  }

  return !/\b(assign|always|initial|generate|for|if|case|[A-Za-z_][A-Za-z0-9_$]*\s+[A-Za-z_][A-Za-z0-9_$]*\s*\()/.test(bodyWithoutComments);
}

async function completeRtlWithOpenAI(verilogCode: string, originalInput: string): Promise<string> {
  const model = process.env.OPENAI_RTL_MODEL || process.env.OPENAI_PLANNER_MODEL || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: [
              "You complete placeholder Verilog for a safe ASIC OpenLane run.",
              "Return a full synthesizable Verilog module only.",
              "Preserve the original module name and port list unless it is syntactically invalid.",
              "Replace placeholder comments with simple deterministic logic inferred from names.",
              "For data_out/data_in pairs of the same width, pass data_in to data_out and drive zero during reset if rst exists.",
              "Avoid delays, initial blocks, file IO, DPI, memories, vendor primitives, and unsynthesizable constructs.",
            ].join(" "),
          }],
        },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: JSON.stringify({ originalInput, verilogCode }),
          }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "completed_rtl",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              verilogCode: { type: "string" },
              reason: { type: "string" },
            },
            required: ["verilogCode", "reason"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI RTL completion failed with ${response.status}`);
  }

  const body = await response.json() as any;
  const parsed = JSON.parse(extractOpenAIText(body)) as { verilogCode?: string };
  const completed = parsed.verilogCode?.trim();
  if (!completed) {
    throw new Error("OpenAI RTL completion returned no Verilog.");
  }
  return completed;
}

async function collectOpenLaneArtifacts(
  inputDir: string,
  jobId: string,
  artifactsDir: string,
  reportsDir: string,
): Promise<string[]> {
  const collected: string[] = [];
  const runDir = join(inputDir, "runs", "run");
  const candidateFiles = [
    { from: join(runDir, "results", "final", "gds"), toDir: artifactsDir, suffix: ".gds" },
    { from: join(runDir, "results", "final", "def"), toDir: artifactsDir, suffix: ".def" },
    { from: join(runDir, "results", "final", "verilog", "gl"), toDir: artifactsDir, suffix: ".v" },
    { from: join(runDir, "results", "signoff"), toDir: artifactsDir, suffix: ".gds" },
    { from: join(runDir, "reports", "synthesis"), toDir: reportsDir, suffix: ".rpt" },
    { from: join(runDir, "reports", "signoff"), toDir: reportsDir, suffix: ".rpt" },
    { from: join(runDir, "reports", "routing"), toDir: reportsDir, suffix: ".rpt" },
  ];

  for (const candidate of candidateFiles) {
    try {
      const files = await fs.readdir(candidate.from);
      for (const file of files.filter((item) => item.endsWith(candidate.suffix)).slice(0, 5)) {
        const source = join(candidate.from, file);
        const target = join(candidate.toDir, file);
        await fs.copyFile(source, target);
        const folder = candidate.toDir === artifactsDir ? "artifacts" : "reports";
        const artifactPath = `jobs/${jobId}/${folder}/${file}`;
        if (!collected.includes(artifactPath)) {
          collected.push(artifactPath);
        }
      }
    } catch {
      // Some OpenLane stages may not produce every artifact.
    }
  }

  return collected;
}

function extractVerilog(input: string): string {
  const fenceMatch = input.match(/```(?:verilog|systemverilog|sv)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]?.trim()) {
    return fenceMatch[1].trim();
  }

  const moduleIndex = input.search(/\bmodule\s+[A-Za-z_][A-Za-z0-9_$]*/);
  if (moduleIndex >= 0) {
    return input.slice(moduleIndex).trim();
  }

  return [
    "module counter4(",
    "  input wire clk,",
    "  input wire rst,",
    "  output reg [3:0] count",
    ");",
    "  always @(posedge clk or posedge rst) begin",
    "    if (rst) begin",
    "      count <= 4'd0;",
    "    end else begin",
    "      count <= count + 4'd1;",
    "    end",
    "  end",
    "endmodule",
    "",
  ].join("\n");
}

function inferTopModule(verilogCode: string): string {
  const match = verilogCode.match(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/);
  if (!match?.[1]) {
    throw new Error("No Verilog module declaration found.");
  }
  return match[1];
}

function parseYosysMetrics(log: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  const wireMatch = log.match(/Number of wires:\s+(\d+)/);
  const bitMatch = log.match(/Number of wire bits:\s+(\d+)/);
  const cellMatch = log.match(/Number of cells:\s+(\d+)/);

  if (wireMatch?.[1]) metrics.wires = Number(wireMatch[1]);
  if (bitMatch?.[1]) metrics.wireBits = Number(bitMatch[1]);
  if (cellMatch?.[1]) metrics.cells = Number(cellMatch[1]);

  return metrics;
}

function formatSynthesisSummary(topModule: string, metrics: Record<string, number>, mocked: boolean): string {
  if (mocked) {
    return `Synthesis demo completed for ${topModule}, but Yosys was not available so the result is mocked.`;
  }

  const parts = [`Real Yosys synthesis completed for ${topModule}.`];
  if (metrics.cells !== undefined) parts.push(`${metrics.cells} cells`);
  if (metrics.wires !== undefined) parts.push(`${metrics.wires} wires`);
  if (metrics.wireBits !== undefined) parts.push(`${metrics.wireBits} wire bits`);
  return parts.join(" ");
}

async function summarizeSynthesisResult(
  topModule: string,
  metrics: Record<string, number>,
  log: string,
  plannerDecision?: PlannerDecision,
): Promise<string> {
  const fallback = formatSynthesisSummary(topModule, metrics, false);
  if (!process.env.OPENAI_API_KEY) {
    return fallback;
  }

  try {
    const model = process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_PLANNER_MODEL || "gpt-4o-mini";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: "Summarize a Yosys synthesis result for a hardware designer in 2 concise sentences. Mention whether this was real synthesis and include key metrics if present." }],
          },
          {
            role: "user",
            content: [{
              type: "input_text",
              text: JSON.stringify({
                topModule,
                metrics,
                plannerDecision,
                logTail: log.slice(-4000),
              }),
            }],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI summarizer failed with ${response.status}`);
    }

    const body = await response.json() as any;
    return extractOpenAIText(body) || fallback;
  } catch {
    return fallback;
  }
}

function extractOpenAIText(body: any): string {
  if (typeof body.output_text === "string") {
    return body.output_text.trim();
  }

  for (const item of body.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text.trim();
      }
    }
  }

  return "";
}

function publicJob(job: JobRecord): Omit<JobRecord, "input"> & { inputPreview: string } {
  const { input, ...rest } = job;
  return {
    ...rest,
    inputPreview: job.input.slice(0, 240),
  };
}

async function readJobArtifact(job: JobRecord, artifactPath: string): Promise<{ path: string; content: string }> {
  const decodedPath = decodeURIComponent(artifactPath);
  const allowed = job.artifactPaths.includes(decodedPath);
  if (!allowed) {
    throw new Error("Artifact is not registered for this job.");
  }

  const prefix = `jobs/${job.id}/`;
  if (!decodedPath.startsWith(prefix)) {
    throw new Error("Artifact path does not belong to this job.");
  }

  const relativePath = decodedPath.slice(prefix.length);
  const normalizedRelative = normalize(relativePath);
  if (
    normalizedRelative.startsWith("..") ||
    normalizedRelative.includes(`${sep}..${sep}`) ||
    normalizedRelative.length === 0
  ) {
    throw new Error("Invalid artifact path.");
  }

  const diskPath = join(jobStorageRoot, job.id, normalizedRelative);
  const content = await fs.readFile(diskPath, "utf8");
  return { path: decodedPath, content };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const correlationId =
    typeof request.headers["x-correlation-id"] === "string"
      ? request.headers["x-correlation-id"]
      : randomUUID();
  const sessionId =
    typeof request.headers["x-session-id"] === "string"
      ? request.headers["x-session-id"]
      : "anonymous";
  const url = new URL(request.url || "/", "http://localhost");

  console.info(JSON.stringify({ correlationId, method: request.method, path: url.pathname }));

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {}, correlationId);
    return;
  }

  if (isRateLimited(request)) {
    sendJson(response, 429, { error: { code: "rate_limited", message: "Too many requests." } }, correlationId);
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await sendStaticFile(response, join(process.cwd(), "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (request.method === "GET" && url.pathname === "/config.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end("window.EDA_COPILOT_API_URL = window.location.origin;\n");
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: "eda-copilot-api",
      plannerMode: process.env.OPENAI_API_KEY ? "llm_openai" : "rule_based",
      plannerModel: process.env.OPENAI_API_KEY ? (process.env.OPENAI_PLANNER_MODEL || "gpt-4o-mini") : undefined,
      time: new Date().toISOString(),
    }, correlationId);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJsonBody(request);
    const message = stringField(body, "message", { required: true, maxLength: 16_000 });
    const decision = await planIntent(message);

    if (decision.action === "unsupported") {
      sendJson(response, 422, {
        reply: "I can help with synthesis, simulation, real OpenLane flows, and report summaries.",
        plannerDecision: decision,
      }, correlationId);
      return;
    }

    const job = createJob(decision.action, buildJobInput(message, decision), sessionId, correlationId, decision);
    sendJson(response, 202, {
      reply: `Queued ${decision.action.replaceAll("_", " ")}.`,
      plannerDecision: decision,
      job: publicJob(job),
    }, correlationId);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readJsonBody(request);
    const type = stringField(body, "type", { required: true }) as AllowedAction;
    const input = stringField(body, "input", { required: true, maxLength: 16_000 });
    const allowed: AllowedAction[] = [
      "synthesize_verilog",
      "simulate_verilog",
      "summarize_report",
      "run_openlane_flow",
    ];

    if (!allowed.includes(type)) {
      sendJson(response, 400, {
        error: { code: "invalid_job_type", message: "Job type is not allowlisted.", allowed },
      }, correlationId);
      return;
    }

    const job = createJob(type, input, sessionId, correlationId);
    sendJson(response, 202, { job: publicJob(job) }, correlationId);
    return;
  }

  const artifactContentMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/artifacts\/(.+)$/);
  if (request.method === "GET" && artifactContentMatch) {
    const job = jobs.get(artifactContentMatch[1] || "");
    if (!job) {
      sendJson(response, 404, { error: { code: "not_found", message: "Job not found." } }, correlationId);
      return;
    }

    try {
      const artifact = await readJobArtifact(job, `jobs/${job.id}/${artifactContentMatch[2] || ""}`);
      sendJson(response, 200, artifact, correlationId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 404, { error: { code: "artifact_not_found", message } }, correlationId);
    }
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(\/artifacts)?$/);
  if (request.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1] || "");
    if (!job) {
      sendJson(response, 404, { error: { code: "not_found", message: "Job not found." } }, correlationId);
      return;
    }

    if (jobMatch[2]) {
      sendJson(response, 200, { jobId: job.id, artifacts: job.artifactPaths }, correlationId);
      return;
    }

    sendJson(response, 200, { job: publicJob(job) }, correlationId);
    return;
  }

  sendJson(response, 404, { error: { code: "not_found", message: "Route not found." } }, correlationId);
}

const port = Number(process.env.PORT || 8080);
const server = createServer((request, response) => {
  handleRequest(request, response).catch((error: unknown) => {
    const correlationId =
      typeof request.headers["x-correlation-id"] === "string"
        ? request.headers["x-correlation-id"]
        : randomUUID();
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 400, { error: { code: "bad_request", message } }, correlationId);
  });
});

server.listen(port, () => {
  console.info(`EDA Copilot API listening on http://localhost:${port}`);
});
