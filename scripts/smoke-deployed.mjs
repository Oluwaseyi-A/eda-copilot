const baseUrl = process.argv[2];

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-deployed.mjs https://SERVICE_URL");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

const health = await getJson("/api/health");
console.log(`health ok=${health.ok} planner=${health.plannerMode}`);

const pageResponse = await fetch(`${baseUrl}/`);
const page = await pageResponse.text();
if (!pageResponse.ok || !page.includes("<title>EDA Copilot</title>")) {
  throw new Error("Hosted page did not load EDA Copilot.");
}
console.log("page ok=true");

const chatResponse = await fetch(`${baseUrl}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "synthesize a 4-bit adder" }),
});
if (chatResponse.status !== 202) {
  throw new Error(`/api/chat failed with ${chatResponse.status}: ${await chatResponse.text()}`);
}

const chat = await chatResponse.json();
console.log(`job id=${chat.job.id} status=${chat.job.status}`);

const asicResponse = await fetch(`${baseUrl}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    message: `Run the complete ASIC flow for this design with a 10ns clock period
module simple_cpu(
  input clk,
  input rst,
  input [7:0] data_in,
  output [7:0] data_out
);
endmodule`,
  }),
});
if (asicResponse.status !== 202) {
  throw new Error(`ASIC flow prompt should queue an OpenLane flow, got ${asicResponse.status}: ${await asicResponse.text()}`);
}
const asic = await asicResponse.json();
if (asic.plannerDecision?.action !== "run_openlane_flow") {
  throw new Error(`Expected run_openlane_flow, got ${JSON.stringify(asic.plannerDecision)}`);
}
console.log(`asic planner action=${asic.plannerDecision.action}`);

let job;
for (let attempt = 0; attempt < 12; attempt += 1) {
  const body = await getJson(`/api/jobs/${chat.job.id}`);
  job = body.job;
  console.log(`job status=${job.status}`);
  if (job.status === "completed") break;
  await sleep(1000);
}

if (job?.status !== "completed") {
  throw new Error(`Expected completed job, got ${job?.status || "unknown"}`);
}

const artifacts = await getJson(`/api/jobs/${chat.job.id}/artifacts`);
if (!Array.isArray(artifacts.artifacts) || !artifacts.artifacts.some((item) => item.endsWith("result.json"))) {
  throw new Error(`Expected result.json artifact, got ${JSON.stringify(artifacts)}`);
}
console.log(`artifacts count=${artifacts.artifacts.length}`);

const resultArtifact = artifacts.artifacts.find((item) => item.endsWith("result.json"));
const resultPath = resultArtifact.replace(`jobs/${chat.job.id}/`, "");
const content = await getJson(`/api/jobs/${chat.job.id}/artifacts/${encodeURIComponent(resultPath)}`);
if (!content.content.includes(chat.job.id)) {
  throw new Error("Result artifact content did not include the job id.");
}

console.log("deployed smoke test passed");
