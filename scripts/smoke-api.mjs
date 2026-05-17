import { spawn, spawnSync } from "node:child_process";

const api = spawn(process.execPath, ["build/cloud-api.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: "8090" },
});
const yosysAvailable = spawnSync("yosys", ["-V"], { stdio: "ignore" }).status === 0;

let stderr = "";
api.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://localhost:8090/api/health");
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`API did not become healthy.\n${stderr}`);
}

async function main() {
  await waitForHealth();

  const chatResponse = await fetch("http://localhost:8090/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Synthesize this 4-bit counter." }),
  });

  if (chatResponse.status !== 202) {
    throw new Error(`Expected /api/chat status 202, got ${chatResponse.status}: ${await chatResponse.text()}`);
  }

  const chat = await chatResponse.json();
  if (!chat.job?.id || chat.job.status !== "queued") {
    throw new Error(`Unexpected chat response: ${JSON.stringify(chat)}`);
  }

  const deadline = Date.now() + 5000;
  let job;
  while (Date.now() < deadline) {
    const jobResponse = await fetch(`http://localhost:8090/api/jobs/${chat.job.id}`);
    if (!jobResponse.ok) {
      throw new Error(`Job polling failed with status ${jobResponse.status}`);
    }
    const body = await jobResponse.json();
    job = body.job;
    if (job.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (job?.status !== "completed") {
    throw new Error(`Expected completed job, got ${job?.status || "unknown"}`);
  }
  if (yosysAvailable && !job.summary?.includes("Real Yosys synthesis completed")) {
    throw new Error(`Expected a real Yosys synthesis summary, got: ${job.summary}`);
  }

  const artifactsResponse = await fetch(`http://localhost:8090/api/jobs/${chat.job.id}/artifacts`);
  if (!artifactsResponse.ok) {
    throw new Error(`Artifact lookup failed with status ${artifactsResponse.status}`);
  }
  const artifacts = await artifactsResponse.json();
  if (!Array.isArray(artifacts.artifacts) || artifacts.artifacts.length === 0) {
    throw new Error(`Expected artifacts, got ${JSON.stringify(artifacts)}`);
  }
  if (yosysAvailable && !artifacts.artifacts.some((artifact) => artifact.endsWith("synth_output.v"))) {
    throw new Error(`Expected synthesized netlist artifact, got ${JSON.stringify(artifacts)}`);
  }

  const resultArtifact = artifacts.artifacts.find((artifact) => artifact.endsWith("result.json"));
  const relativeResultPath = resultArtifact.replace(`jobs/${chat.job.id}/`, "");
  const contentResponse = await fetch(
    `http://localhost:8090/api/jobs/${chat.job.id}/artifacts/${encodeURIComponent(relativeResultPath)}`,
  );
  if (!contentResponse.ok) {
    throw new Error(`Artifact content lookup failed with status ${contentResponse.status}`);
  }
  const content = await contentResponse.json();
  if (!content.content?.includes(chat.job.id)) {
    throw new Error(`Expected result artifact content to mention job id, got ${JSON.stringify(content)}`);
  }

  console.log(`API smoke test passed for job ${chat.job.id}${yosysAvailable ? " with real Yosys synthesis" : " with fallback synthesis"}`);
}

try {
  await main();
} finally {
  api.kill("SIGTERM");
}
