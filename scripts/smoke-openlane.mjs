const baseUrl = process.argv[2] || "http://localhost:8080";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const prompt = `Run the complete ASIC flow for this design with a 10ns clock period
\`\`\`verilog
module simple_cpu(
  input clk,
  input rst,
  input [7:0] data_in,
  output [7:0] data_out
);
  assign data_out = rst ? 8'h00 : data_in;
endmodule
\`\`\``;

const response = await fetch(`${baseUrl}/api/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "run_openlane_flow",
    input: prompt,
  }),
});

if (response.status !== 202) {
  throw new Error(`Expected queued OpenLane job, got ${response.status}: ${await response.text()}`);
}

const created = await response.json();
const jobId = created.job.id;
console.log(`openlane job id=${jobId}`);

let job;
for (let attempt = 0; attempt < 90; attempt += 1) {
  const jobResponse = await fetch(`${baseUrl}/api/jobs/${jobId}`);
  const body = await jobResponse.json();
  job = body.job;
  console.log(`openlane status=${job.status}`);
  if (job.status === "completed" || job.status === "failed") break;
  await sleep(2000);
}

const artifacts = await fetch(`${baseUrl}/api/jobs/${jobId}/artifacts`).then((item) => item.json());
console.log(JSON.stringify({ status: job.status, summary: job.summary, artifacts: artifacts.artifacts }, null, 2));

if (job.status !== "completed") {
  throw new Error("OpenLane job did not complete.");
}
