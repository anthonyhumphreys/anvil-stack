import type {
  AgentDefinition,
  AgentRuntime,
  AgentRuntimeInvokeResult,
  AgentToolExecutor,
} from "./agent.js";

export type AgentEvalCapabilityAssertions = {
  used?: string[];
  notUsed?: string[];
};

export type AgentEvalAssertions = {
  responseIncludes?: string | string[];
  toolCalls?: {
    count?: number;
    names?: string[];
  };
  approvalsRequired?: string[];
  capabilities?: AgentEvalCapabilityAssertions;
};

export type AgentEvalScenario = {
  name: string;
  input: string;
  context?: Record<string, unknown>;
  expect?: AgentEvalAssertions;
};

export type AgentEvalSuite = {
  scenarios: AgentEvalScenario[];
};

export type AgentEvalBaselineScenario = {
  responseText: string;
  toolCalls: string[];
  approvalsRequired: string[];
};

export type AgentEvalBaseline = {
  agents: Record<
    string,
    {
      scenarios: Record<string, AgentEvalBaselineScenario>;
    }
  >;
};

export type AgentEvalScenarioResult = {
  name: string;
  ok: boolean;
  score: number;
  input: string;
  responseText: string;
  toolCalls: string[];
  approvalsRequired: string[];
  capabilityUsage: string[];
  assertions: AgentEvalAssertionResult[];
  baseline?: AgentEvalBaselineResult;
};

export type AgentEvalAssertionResult = {
  ok: boolean;
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
};

export type AgentEvalBaselineResult = {
  ok: boolean;
  expected?: AgentEvalBaselineScenario;
  diffs: AgentEvalAssertionResult[];
};

export type AgentEvalRunResult = {
  ok: boolean;
  agentName: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    score: number;
  };
  scenarios: AgentEvalScenarioResult[];
  baseline: AgentEvalBaseline;
};

export type RunAgentEvalSuiteOptions = {
  runtime: AgentRuntime;
  tools?: AgentToolExecutor[];
  baseline?: AgentEvalBaseline;
};

export function defineAgentEvalSuite(suite: AgentEvalSuite): AgentEvalSuite {
  return suite;
}

export function createAgentEvalToolExecutors(
  agent: AgentDefinition,
): AgentToolExecutor[] | undefined {
  const definitions = Array.isArray(agent.tools) ? agent.tools : [];

  if (definitions.length === 0) {
    return undefined;
  }

  return definitions.map((definition) => ({
    definition,
    execute: async () => ({ ok: true }),
  }));
}

export async function runAgentEvalSuite(
  agent: AgentDefinition,
  suite: AgentEvalSuite,
  options: RunAgentEvalSuiteOptions,
): Promise<AgentEvalRunResult> {
  const scenarios = await Promise.all(
    suite.scenarios.map((scenario) =>
      runAgentEvalScenario(agent, scenario, options),
    ),
  );
  const passed = scenarios.filter((scenario) => scenario.ok).length;
  const score =
    scenarios.length === 0
      ? 1
      : scenarios.reduce((total, scenario) => total + scenario.score, 0) /
        scenarios.length;

  return {
    ok: scenarios.every((scenario) => scenario.ok),
    agentName: agent.name,
    summary: {
      total: scenarios.length,
      passed,
      failed: scenarios.length - passed,
      score,
    },
    scenarios,
    baseline: {
      agents: {
        [agent.name]: {
          scenarios: Object.fromEntries(
            scenarios.map((scenario) => [
              scenario.name,
              scenarioBaselineSnapshot(scenario),
            ]),
          ),
        },
      },
    },
  };
}

async function runAgentEvalScenario(
  agent: AgentDefinition,
  scenario: AgentEvalScenario,
  options: RunAgentEvalSuiteOptions,
): Promise<AgentEvalScenarioResult> {
  const invocation = await options.runtime.invoke(agent, {
    input: scenario.input,
    ...(scenario.context === undefined ? {} : { context: scenario.context }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  const responseText = messageText(invocation.response.content);
  const toolCalls = invocation.toolCalls.map((call) => call.name);
  const approvalsRequired = invocation.approvalsRequired.map(
    (approval) => approval.action,
  );
  const capabilityUsage = capabilityUsageFor(invocation, options.tools ?? []);
  const assertions = evaluateAssertions(scenario, {
    responseText,
    toolCalls,
    approvalsRequired,
    capabilityUsage,
  });
  const baseline = evaluateBaseline(
    options.baseline?.agents?.[agent.name]?.scenarios?.[scenario.name],
    {
      responseText,
      toolCalls,
      approvalsRequired,
    },
  );
  const allAssertions = baseline
    ? [...assertions, ...baseline.diffs]
    : assertions;
  const ok = allAssertions.every((assertion) => assertion.ok);

  return {
    name: scenario.name,
    ok,
    score: ok ? 1 : 0,
    input: scenario.input,
    responseText,
    toolCalls,
    approvalsRequired,
    capabilityUsage,
    assertions,
    ...(baseline === undefined ? {} : { baseline }),
  };
}

function evaluateAssertions(
  scenario: AgentEvalScenario,
  actual: {
    responseText: string;
    toolCalls: string[];
    approvalsRequired: string[];
    capabilityUsage: string[];
  },
): AgentEvalAssertionResult[] {
  const assertions: AgentEvalAssertionResult[] = [];
  const expectedResponseIncludes = arrayify(scenario.expect?.responseIncludes);

  for (const expected of expectedResponseIncludes) {
    assertions.push({
      ok: actual.responseText.includes(expected),
      code: "RESPONSE_INCLUDES",
      message: `Response includes '${expected}'.`,
      expected,
      actual: actual.responseText,
    });
  }

  if (scenario.expect?.toolCalls?.count !== undefined) {
    assertions.push({
      ok: actual.toolCalls.length === scenario.expect.toolCalls.count,
      code: "TOOL_CALL_COUNT",
      message: `Tool call count is ${scenario.expect.toolCalls.count}.`,
      expected: scenario.expect.toolCalls.count,
      actual: actual.toolCalls.length,
    });
  }

  for (const expected of scenario.expect?.toolCalls?.names ?? []) {
    assertions.push({
      ok: actual.toolCalls.includes(expected),
      code: "TOOL_CALL_PRESENT",
      message: `Tool '${expected}' was called.`,
      expected,
      actual: actual.toolCalls,
    });
  }

  for (const expected of scenario.expect?.approvalsRequired ?? []) {
    assertions.push({
      ok: actual.approvalsRequired.includes(expected),
      code: "APPROVAL_REQUIRED",
      message: `Approval '${expected}' was requested.`,
      expected,
      actual: actual.approvalsRequired,
    });
  }

  for (const expected of scenario.expect?.capabilities?.used ?? []) {
    assertions.push({
      ok: actual.capabilityUsage.includes(expected),
      code: "CAPABILITY_USED",
      message: `Capability '${expected}' was used.`,
      expected,
      actual: actual.capabilityUsage,
    });
  }

  for (const expected of scenario.expect?.capabilities?.notUsed ?? []) {
    assertions.push({
      ok: !actual.capabilityUsage.includes(expected),
      code: "CAPABILITY_NOT_USED",
      message: `Capability '${expected}' was not used.`,
      expected,
      actual: actual.capabilityUsage,
    });
  }

  if (assertions.length === 0) {
    assertions.push({
      ok: true,
      code: "NO_ASSERTIONS",
      message: "Scenario executed without explicit assertions.",
    });
  }

  return assertions;
}

function evaluateBaseline(
  expected: AgentEvalBaselineScenario | undefined,
  actual: AgentEvalBaselineScenario,
): AgentEvalBaselineResult | undefined {
  if (expected === undefined) {
    return undefined;
  }

  const diffs: AgentEvalAssertionResult[] = [
    compareBaselineField("BASELINE_RESPONSE", "responseText", expected, actual),
    compareBaselineField("BASELINE_TOOL_CALLS", "toolCalls", expected, actual),
    compareBaselineField(
      "BASELINE_APPROVALS",
      "approvalsRequired",
      expected,
      actual,
    ),
  ];

  return {
    ok: diffs.every((diff) => diff.ok),
    expected,
    diffs,
  };
}

function compareBaselineField<TKey extends keyof AgentEvalBaselineScenario>(
  code: string,
  key: TKey,
  expected: AgentEvalBaselineScenario,
  actual: AgentEvalBaselineScenario,
): AgentEvalAssertionResult {
  const ok = JSON.stringify(expected[key]) === JSON.stringify(actual[key]);

  return {
    ok,
    code,
    message: `Baseline ${key} matches.`,
    expected: expected[key],
    actual: actual[key],
  };
}

function scenarioBaselineSnapshot(
  scenario: AgentEvalScenarioResult,
): AgentEvalBaselineScenario {
  return {
    responseText: scenario.responseText,
    toolCalls: scenario.toolCalls,
    approvalsRequired: scenario.approvalsRequired,
  };
}

function capabilityUsageFor(
  invocation: AgentRuntimeInvokeResult,
  tools: AgentToolExecutor[],
): string[] {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const capabilities = invocation.toolCalls.flatMap(
    (call) => byName.get(call.name)?.definition.requiredCapabilities ?? [],
  );

  return [...new Set(capabilities)].sort();
}

function messageText(
  content: AgentRuntimeInvokeResult["response"]["content"],
): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) =>
      part.type === "text" ? part.text : JSON.stringify(part.value),
    )
    .join("");
}

function arrayify(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}
