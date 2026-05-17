export type AllowedAction =
  | "synthesize_verilog"
  | "simulate_verilog"
  | "summarize_report"
  | "run_openlane_flow";

export type PlannerMode = "rule_based" | "llm_openai";

export interface PlannerDecision {
  action: AllowedAction | "unsupported";
  confidence: number;
  reason: string;
  plannerMode: PlannerMode;
  parameters: {
    topModule?: string;
    hasVerilog: boolean;
    requestedFlow?: string;
    designType?: string;
    bitWidth?: number;
    verilogCode?: string;
  };
}

interface LlmPlannerResponse {
  action: AllowedAction | "unsupported";
  confidence: number;
  reason: string;
  parameters: {
    topModule?: string;
    hasVerilog?: boolean;
    requestedFlow?: string;
    designType?: string;
    bitWidth?: number;
    verilogCode?: string;
  };
}

const allowedActions: Array<AllowedAction | "unsupported"> = [
  "synthesize_verilog",
  "simulate_verilog",
  "summarize_report",
  "run_openlane_flow",
  "unsupported",
];

export async function planIntent(message: string): Promise<PlannerDecision> {
  if (!process.env.OPENAI_API_KEY) {
    return classifyIntent(message);
  }

  try {
    return await planIntentWithOpenAI(message);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return decision("unsupported", 0, `OpenAI planner failed: ${detail}`, {
      hasVerilog: /\bmodule\s+[A-Za-z_][A-Za-z0-9_$]*/.test(message),
      topModule: inferTopModuleName(message),
    });
  }
}

export function classifyIntent(message: string): PlannerDecision {
  const normalized = message.toLowerCase();
  const hasVerilog = /\bmodule\s+[A-Za-z_][A-Za-z0-9_$]*/.test(message);
  const topModule = inferTopModuleName(message);

  if (requestsPhysicalDesignFlow(normalized)) {
    return decision("run_openlane_flow", 0.86, "Matched a request for an OpenLane RTL-to-GDS flow.", {
      hasVerilog,
      topModule,
      requestedFlow: "openlane",
    });
  }

  if (normalized.includes("simulate") || normalized.includes("testbench") || normalized.includes("vcd")) {
    return decision("simulate_verilog", 0.82, "Matched a Verilog simulation workflow.", {
      hasVerilog,
      topModule,
      requestedFlow: "icarus_verilog",
    });
  }

  if (normalized.includes("report") || normalized.includes("timing") || normalized.includes("summary")) {
    return decision("summarize_report", 0.78, "Matched a report summarization workflow.", {
      hasVerilog,
      topModule,
      requestedFlow: "report_summary",
    });
  }

  if (
    normalized.includes("synthesize") ||
    normalized.includes("yosys") ||
    normalized.includes("verilog") ||
    normalized.includes("counter")
  ) {
    return decision("synthesize_verilog", 0.8, "Matched a Verilog synthesis workflow.", {
      hasVerilog,
      topModule,
      requestedFlow: "yosys",
    });
  }

  return decision("unsupported", 0.35, "The request did not map to a safe allowlisted EDA action.", {
    hasVerilog,
    topModule,
  });
}

function decision(
  action: AllowedAction | "unsupported",
  confidence: number,
  reason: string,
  parameters: PlannerDecision["parameters"],
): PlannerDecision {
  return {
    action,
    confidence,
    reason,
    plannerMode: "rule_based",
    parameters,
  };
}

function inferTopModuleName(message: string): string | undefined {
  const match = message.match(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/);
  return match?.[1];
}

function requestsPhysicalDesignFlow(normalized: string): boolean {
  return [
    "openlane",
    "gds",
    "rtl-to-gds",
    "rtl to gds",
    "asic",
    "complete flow",
    "physical design",
    "run the rtl",
  ].some((phrase) => normalized.includes(phrase));
}

async function planIntentWithOpenAI(message: string): Promise<PlannerDecision> {
  const model = process.env.OPENAI_PLANNER_MODEL || "gpt-4o-mini";
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
          content: [
            {
              type: "input_text",
              text: [
                "You are a safe EDA workflow planner.",
                "Map the user request to exactly one allowlisted action.",
                "Allowed actions: synthesize_verilog, simulate_verilog, summarize_report, run_openlane_flow, unsupported.",
                "Map ASIC flow, physical design flow, OpenLane, GDS, RTL-to-GDS, complete flow, or run the RTL requests to run_openlane_flow.",
                "Never request arbitrary shell execution, file system access, package installation, networking, or unlisted tools.",
                "For simple requested designs without provided Verilog, you may generate small synthesizable Verilog.",
                "If provided Verilog is a placeholder or empty skeleton, generate complete synthesizable Verilog that preserves the module name and ports.",
                "If generating Verilog, keep it simple, safe, and self-contained.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: message }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "eda_planner_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: allowedActions },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string" },
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  topModule: { type: ["string", "null"] },
                  hasVerilog: { type: "boolean" },
                  requestedFlow: { type: ["string", "null"] },
                  designType: { type: ["string", "null"] },
                  bitWidth: { type: ["number", "null"] },
                  verilogCode: { type: ["string", "null"] },
                },
                required: ["topModule", "hasVerilog", "requestedFlow", "designType", "bitWidth", "verilogCode"],
              },
            },
            required: ["action", "confidence", "reason", "parameters"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI planner failed with ${response.status}`);
  }

  const body = await response.json() as any;
  const outputText = extractResponseText(body);
  const parsed = JSON.parse(outputText) as LlmPlannerResponse;
  return normalizeLlmDecision(parsed, message);
}

function extractResponseText(body: any): string {
  if (typeof body.output_text === "string") {
    return body.output_text;
  }

  for (const item of body.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  throw new Error("OpenAI planner returned no output text.");
}

function normalizeLlmDecision(parsed: LlmPlannerResponse, originalMessage: string): PlannerDecision {
  if (!allowedActions.includes(parsed.action)) {
    throw new Error("OpenAI planner returned an unsupported action.");
  }

  const verilogCode = parsed.parameters.verilogCode?.trim();
  const hasVerilog = Boolean(parsed.parameters.hasVerilog || verilogCode || /\bmodule\s+[A-Za-z_][A-Za-z0-9_$]*/.test(originalMessage));

  return {
    action: parsed.action,
    confidence: clamp(parsed.confidence, 0, 1),
    reason: parsed.reason,
    plannerMode: "llm_openai",
    parameters: {
      topModule: parsed.parameters.topModule || (verilogCode ? inferTopModuleName(verilogCode) : inferTopModuleName(originalMessage)),
      hasVerilog,
      requestedFlow: parsed.parameters.requestedFlow,
      designType: parsed.parameters.designType,
      bitWidth: parsed.parameters.bitWidth,
      verilogCode,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
