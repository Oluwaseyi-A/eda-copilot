#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { join, normalize, sep, basename } from "path";
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

  if (job.type === "simulate_verilog") {
    await executeSimulationJob(job);
    return;
  }

  if (job.type === "summarize_report") {
    await executeReportSummaryJob(job);
    return;
  }
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

async function executeSimulationJob(job: JobRecord): Promise<void> {
  const jobDir = join(jobStorageRoot, job.id);
  const inputDir = join(jobDir, "input");
  const logsDir = join(jobDir, "logs");
  const artifactsDir = join(jobDir, "artifacts");
  const logPath = join(logsDir, "iverilog.log");
  const resultPath = join(artifactsDir, "result.json");

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });

  const { designCode, testbenchCode } = extractSimulationFiles(job.input);

  if (!testbenchCode) {
    await fs.writeFile(resultPath, JSON.stringify({
      jobId: job.id, type: job.type, status: "failed",
      error: "No testbench provided.",
    }, null, 2));
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.artifactPaths = [`jobs/${job.id}/artifacts/result.json`];
    job.summary = "Simulation requires a testbench. Provide two Verilog blocks — the design module first, then a testbench with `$dumpfile`, `$dumpvars`, and `$finish`.";
    return;
  }

  const designPath = join(inputDir, "design.v");
  const tbPath = join(inputDir, "testbench.v");
  const simBinaryPath = join(inputDir, "simulation");
  const MAX_VCD_BYTES = 10 * 1024 * 1024;

  await fs.writeFile(designPath, designCode);
  const selfContained = testbenchCode === designCode;
  if (!selfContained) await fs.writeFile(tbPath, testbenchCode);

  const compileArgs = selfContained
    ? ["-o", simBinaryPath, designPath]
    : ["-o", simBinaryPath, designPath, tbPath];

  try {
    const { stdout: compileOut, stderr: compileErr } = await execFileAsync(
      "iverilog", compileArgs,
      { timeout: 30_000, killSignal: "SIGKILL" as NodeJS.Signals, maxBuffer: 4 * 1024 * 1024 },
    );

    let simOut = "";
    let simErr = "";
    let timedOut = false;

    try {
      const simResult = await execFileAsync(
        "vvp", [simBinaryPath],
        { cwd: inputDir, timeout: 30_000, killSignal: "SIGKILL" as NodeJS.Signals, maxBuffer: 8 * 1024 * 1024 },
      );
      simOut = simResult.stdout;
      simErr = simResult.stderr;
    } catch (simError: any) {
      if (simError.killed) {
        timedOut = true;
        simOut = typeof simError.stdout === "string" ? simError.stdout : "";
        simErr = typeof simError.stderr === "string" ? simError.stderr : "";
      } else {
        throw simError;
      }
    }

    const fullLog = [compileOut, compileErr, simOut, simErr].filter(Boolean).join("\n");
    await fs.writeFile(logPath, fullLog);

    const vcdArtifacts: string[] = [];
    let vcdNote = "";
    try {
      const dirFiles = await fs.readdir(inputDir);
      for (const f of dirFiles.filter((f) => f.endsWith(".vcd"))) {
        const src = join(inputDir, f);
        const stat = await fs.stat(src);
        if (stat.size > MAX_VCD_BYTES) {
          await fs.unlink(src);
          vcdNote = `VCD \`${f}\` exceeded 10 MB and was discarded — reduce simulation duration or dump scope.`;
        } else if (stat.size > 0) {
          await fs.copyFile(src, join(artifactsDir, f));
          vcdArtifacts.push(`jobs/${job.id}/artifacts/${f}`);
        }
      }
    } catch { /* no VCD generated */ }

    await fs.writeFile(resultPath, JSON.stringify({
      jobId: job.id, type: job.type,
      status: timedOut ? "timed_out" : "completed",
      timedOut, vcdGenerated: vcdArtifacts.length > 0,
      stdout: simOut.slice(0, 2000), stderr: simErr.slice(0, 2000),
    }, null, 2));

    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.artifactPaths = [
      `jobs/${job.id}/input/design.v`,
      ...(!selfContained ? [`jobs/${job.id}/input/testbench.v`] : []),
      `jobs/${job.id}/logs/iverilog.log`,
      ...vcdArtifacts,
      `jobs/${job.id}/artifacts/result.json`,
    ];

    const parts: string[] = [];
    parts.push(timedOut
      ? "Simulation **timed out** after 30 seconds — ensure `$finish` is called and check for infinite loops."
      : "Real **Icarus Verilog** simulation completed.");
    parts.push(vcdArtifacts.length > 0
      ? `VCD waveform \`${vcdArtifacts[0].split("/").pop()}\` is in the Artifacts tab.`
      : "No VCD generated — add `$dumpfile` and `$dumpvars` to your testbench.");
    if (vcdNote) parts.push(vcdNote);
    if (simOut.trim()) parts.push(`\n**stdout:**\n\`\`\`\n${simOut.slice(0, 400)}\n\`\`\``);
    job.summary = parts.join(" ");

  } catch (error: any) {
    if (error?.code === "ENOENT") {
      await fs.writeFile(logPath, "iverilog not found on PATH.\n");
      await fs.writeFile(resultPath, JSON.stringify({
        jobId: job.id, type: job.type, status: "completed_with_mock",
        note: "Icarus Verilog is not installed in this environment.",
      }, null, 2));
      job.status = "completed";
      job.finishedAt = new Date().toISOString();
      job.artifactPaths = [
        `jobs/${job.id}/input/design.v`,
        `jobs/${job.id}/logs/iverilog.log`,
        `jobs/${job.id}/artifacts/result.json`,
      ];
      job.summary = "Simulation demo completed for the design, but Icarus Verilog was not available — result is mocked.";
      return;
    }
    const errorText = error?.message || String(error);
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    await fs.writeFile(logPath, [stdout, stderr, errorText].filter(Boolean).join("\n"));
    await fs.writeFile(resultPath, JSON.stringify({
      jobId: job.id, type: job.type, status: "failed", error: errorText,
    }, null, 2));
    job.artifactPaths = [
      `jobs/${job.id}/input/design.v`,
      `jobs/${job.id}/logs/iverilog.log`,
      `jobs/${job.id}/artifacts/result.json`,
    ];
    throw new Error(`Simulation failed for ${job.id}. See iverilog.log.`);
  }
}

async function executeReportSummaryJob(job: JobRecord): Promise<void> {
  const jobDir = join(jobStorageRoot, job.id);
  const artifactsDir = join(jobDir, "artifacts");
  const resultPath = join(artifactsDir, "result.json");

  await fs.mkdir(artifactsDir, { recursive: true });

  const reportText = job.input.slice(0, 8_000);
  let summary: string;

  if (process.env.OPENAI_API_KEY) {
    try {
      summary = await summarizeReportText(reportText);
    } catch {
      summary = extractReportMetrics(reportText);
    }
  } else {
    summary = extractReportMetrics(reportText);
  }

  await fs.writeFile(resultPath, JSON.stringify({
    jobId: job.id, type: job.type, status: "completed", summary,
  }, null, 2));

  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  job.artifactPaths = [`jobs/${job.id}/artifacts/result.json`];
  job.summary = summary;
}

async function summarizeReportText(reportText: string): Promise<string> {
  const model = process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_PLANNER_MODEL || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: "You are an EDA expert. Summarize the provided OpenLane or EDA tool report in 3–5 sentences using markdown. Extract key metrics: WNS/TNS timing slack, cell count, area, power. Note any violations or critical warnings. Be concise and technical.",
        },
        { role: "user", content: reportText },
      ],
    }),
  });

  if (!response.ok) throw new Error(`OpenAI report summarizer failed with ${response.status}`);
  const body = await response.json() as any;
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty response from OpenAI.");
  return text;
}

function extractReportMetrics(reportText: string): string {
  const parts: string[] = [];
  const wns = reportText.match(/WNS[:\s]+(-?\d+\.?\d*)/i);
  const tns = reportText.match(/TNS[:\s]+(-?\d+\.?\d*)/i);
  const cells = reportText.match(/Number of cells[:\s]+(\d+)/i);
  const area = reportText.match(/Total cell area[:\s]+([\d.]+)/i);

  if (wns) parts.push(`**WNS:** ${wns[1]} ns`);
  if (tns) parts.push(`**TNS:** ${tns[1]} ns`);
  if (cells) parts.push(`**Cells:** ${cells[1]}`);
  if (area) parts.push(`**Area:** ${area[1]} μm²`);

  if (parts.length === 0) {
    return "Report received. Configure `OPENAI_API_KEY` for AI-powered analysis, or paste timing/synthesis report text for metric extraction.";
  }
  return parts.join(" · ") + "\n\nAdd `OPENAI_API_KEY` for a detailed narrative summary.";
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
    job.summary = `Real **OpenLane flow** completed for \`${topModule}\`. ${prepared.summarySuffix}Review \`openlane.log\` and the generated artifacts — GDS layout, DEF, gate-level netlist, and signoff reports — for full flow details.`;
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

  const gdsArtifact = collected.find((p) => p.endsWith(".gds"));
  if (gdsArtifact) {
    const gdsRelative = gdsArtifact.slice(`jobs/${jobId}/`.length);
    const gdsDiskPath = join(jobStorageRoot, jobId, gdsRelative);
    const pngName = basename(gdsRelative, ".gds") + "_preview.png";
    const pngDiskPath = join(artifactsDir, pngName);
    const ok = await generateGdsPreview(gdsDiskPath, pngDiskPath);
    if (ok) {
      collected.unshift(`jobs/${jobId}/artifacts/${pngName}`);
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

function extractSimulationFiles(input: string): { designCode: string; testbenchCode: string | null } {
  const fenceRegex = /```(?:verilog|systemverilog|sv)?\s*([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(input)) !== null) {
    const code = match[1]?.trim();
    if (code) blocks.push(code);
  }

  if (blocks.length >= 2) return { designCode: blocks[0], testbenchCode: blocks[1] };

  const candidate = blocks[0] ?? (input.includes("module ") ? input : "");
  if (!candidate) return { designCode: "", testbenchCode: null };

  const moduleCount = (candidate.match(/\bmodule\s+[A-Za-z_]/g) || []).length;
  if (moduleCount >= 2 && /\$finish|\$dumpfile/.test(candidate)) {
    return { designCode: candidate, testbenchCode: candidate };
  }
  return { designCode: candidate, testbenchCode: null };
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
    return `Synthesis demo completed for \`${topModule}\`, but Yosys was not available — the result is mocked.`;
  }

  const parts = [`Real **Yosys synthesis** completed for \`${topModule}\`.`];
  if (metrics.cells !== undefined) parts.push(`**${metrics.cells} cells**`);
  if (metrics.wires !== undefined) parts.push(`**${metrics.wires} wires**`);
  if (metrics.wireBits !== undefined) parts.push(`**${metrics.wireBits} wire bits**`);
  parts.push("Consider running the **OpenLane flow** next for physical design.");
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
            content: [{ type: "input_text", text: "Summarize a Yosys synthesis result for a hardware designer in 2–3 concise sentences using markdown. Include whether synthesis was real, key metrics (cells, wires, wire bits), and suggest a next step such as running OpenLane for physical design." }],
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

async function generateGdsPreview(gdsPath: string, pngPath: string): Promise<boolean> {
  try {
    const rubyScript = [
      "view = RBA::LayoutView.new",
      "view.load_layout($input, 0)",
      "view.max_hier",
      "view.zoom_fit",
      "view.save_image($output, 1200, 900)",
      "view._destroy",
    ].join("\n");

    const scriptPath = gdsPath + ".export.rb";
    await fs.writeFile(scriptPath, rubyScript, "utf8");

    await execFileAsync("klayout", ["-z", "-rd", `input=${gdsPath}`, "-rd", `output=${pngPath}`, "-r", scriptPath], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen" },
      timeout: 60_000,
    });

    await fs.unlink(scriptPath).catch(() => {});
    const stat = await fs.stat(pngPath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function streamContextualReply(
  message: string,
  decision: PlannerDecision,
  job: JobRecord,
  sendEvent: (data: object) => void,
): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    sendEvent({ type: "token", text: buildStaticContextualReply(decision, job) });
    return;
  }

  const systemPrompt = [
    "You are EDA Copilot, an expert AI assistant for hardware design engineers.",
    "The user submitted an EDA request. You already classified it and queued a job.",
    "Write a helpful 2–4 sentence markdown response that:",
    "states what tool is running and why,",
    "mentions design details you observed (module name, ports, clock, bit width),",
    "sets expectations for what artifacts and results to expect,",
    "and suggests a natural follow-up action.",
    "Use backticks for module names, filenames, and tool names.",
    "Refer to the job as already running. Be concise and expert.",
  ].join(" ");

  const userContent = JSON.stringify({
    userMessage: message,
    action: decision.action,
    topModule: decision.parameters.topModule,
    hasVerilog: decision.parameters.hasVerilog,
    requestedFlow: decision.parameters.requestedFlow,
    designType: decision.parameters.designType,
    bitWidth: decision.parameters.bitWidth,
    jobId: job.id,
    plannerReason: decision.reason,
  });

  const model = process.env.OPENAI_PLANNER_MODEL ?? "gpt-4o-mini";
  const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 280,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!openaiResponse.ok || !openaiResponse.body) {
    sendEvent({ type: "token", text: buildStaticContextualReply(decision, job) });
    return;
  }

  const reader = openaiResponse.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const token = parsed.choices?.[0]?.delta?.content;
        if (typeof token === "string") {
          sendEvent({ type: "token", text: token });
        }
      } catch {
        // skip malformed SSE chunks
      }
    }
  }
}

function buildStaticContextualReply(decision: PlannerDecision, job: JobRecord): string {
  const mod = decision.parameters.topModule ?? "your design";
  const shortId = job.id.slice(0, 8);
  switch (decision.action) {
    case "synthesize_verilog":
      return `Running **Yosys synthesis** on \`${mod}\`. I'll generate an optimized gate-level netlist and report cell count, wire count, and timing. Job \`${shortId}\` is running — artifacts including \`synth_output.v\`, \`yosys.log\`, and \`result.json\` will be ready shortly.`;
    case "simulate_verilog":
      return `Starting **Icarus Verilog** simulation for \`${mod}\`. The testbench will run and capture stdout, stderr, and a VCD waveform. Job \`${shortId}\` is queued.`;
    case "run_openlane_flow":
      return `Launching the full **OpenLane RTL-to-GDS flow** for \`${mod}\` targeting the Sky130A PDK. This runs synthesis → floorplan → placement → routing → signoff and typically takes 60–90 seconds. Job \`${shortId}\` is running — final artifacts include the GDS layout, DEF, gate-level netlist, and signoff reports.`;
    case "summarize_report":
      return `Analyzing the **OpenLane report** for \`${mod}\`. I'll extract timing slack, area utilization, power estimates, and any DRC violations. Job \`${shortId}\` is running.`;
    default:
      return `Job \`${shortId}\` has been queued.`;
  }
}

function publicJob(job: JobRecord): Omit<JobRecord, "input"> & { inputPreview: string } {
  const { input, ...rest } = job;
  return {
    ...rest,
    inputPreview: job.input.slice(0, 240),
  };
}

async function readJobArtifact(job: JobRecord, artifactPath: string): Promise<{ path: string; content: string; encoding?: string }> {
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
  if (diskPath.endsWith(".png")) {
    const buf = await fs.readFile(diskPath);
    return { path: decodedPath, content: buf.toString("base64"), encoding: "base64" };
  }
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

  if (request.method === "POST" && url.pathname === "/api/chat/stream") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (parseError: unknown) {
      const msg = parseError instanceof Error ? parseError.message : "Invalid request body.";
      sendJson(response, 400, { error: { code: "bad_request", message: msg } }, correlationId);
      return;
    }

    let streamMessage: string;
    try {
      streamMessage = stringField(body, "message", { required: true, maxLength: 16_000 });
    } catch (fieldError: unknown) {
      const msg = fieldError instanceof Error ? fieldError.message : "Invalid message field.";
      sendJson(response, 400, { error: { code: "bad_request", message: msg } }, correlationId);
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,x-session-id,x-correlation-id",
      "x-correlation-id": correlationId,
    });

    const sendEvent = (data: object): void => {
      if (!response.writableEnded) {
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      const decision = await planIntent(streamMessage);

      if (decision.action === "unsupported") {
        sendEvent({ type: "token", text: "I can help with **synthesis**, **simulation**, **OpenLane flows**, and **report summaries**. This request doesn't match a supported EDA workflow — try describing a specific design task." });
        sendEvent({ type: "done" });
        response.end();
        return;
      }

      const streamJob = createJob(decision.action, buildJobInput(streamMessage, decision), sessionId, correlationId, decision);
      sendEvent({ type: "job", job: publicJob(streamJob) });

      await streamContextualReply(streamMessage, decision, streamJob, sendEvent);
      sendEvent({ type: "done" });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      sendEvent({ type: "error", text: msg });
    }

    response.end();
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
