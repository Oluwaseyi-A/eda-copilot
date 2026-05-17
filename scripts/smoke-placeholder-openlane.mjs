const baseUrl = process.argv[2] || "http://localhost:8080";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const message = `Run the complete ASIC flow for this design with a 10ns clock period """ module simple_cpu( input clk, input rst, input [7:0] data_in, output [7:0] data_out ); // Your RTL design here endmodule """`;

const chatResponse = await fetch(`${baseUrl}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message }),
});

console.log(`chat status=${chatResponse.status}`);
const chat = await chatResponse.json();
console.log(JSON.stringify({
  reply: chat.reply,
  plannerDecision: chat.plannerDecision,
  job: chat.job,
}, null, 2));

if (chatResponse.status !== 202) {
  throw new Error(`Expected queued placeholder OpenLane job, got ${chatResponse.status}`);
}

const jobId = chat.job.id;
let job;
for (let attempt = 0; attempt < 120; attempt += 1) {
  const jobResponse = await fetch(`${baseUrl}/api/jobs/${jobId}`);
  const body = await jobResponse.json();
  job = body.job;
  console.log(`openlane status=${job.status}`);
  if (job.status === "completed" || job.status === "failed") break;
  await sleep(2000);
}

const artifacts = await fetch(`${baseUrl}/api/jobs/${jobId}/artifacts`).then((item) => item.json());
console.log(JSON.stringify({
  status: job.status,
  summary: job.summary,
  error: job.errorMessage,
  artifacts: artifacts.artifacts,
}, null, 2));

const rtl = await fetch(`${baseUrl}/api/jobs/${jobId}/artifacts/input/simple_cpu.v`).then((item) => item.json());
console.log("--- generated RTL ---");
console.log(rtl.content);

if (job.status !== "completed") {
  throw new Error("Placeholder OpenLane job did not complete.");
}
