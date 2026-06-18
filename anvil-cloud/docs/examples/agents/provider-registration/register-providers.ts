import {
  AgentProviderRegistry,
  AgentRuntime,
  LocalStubInferenceProvider,
} from "@anvil-cloud/runtime";
import { BedrockInferenceProvider } from "@anvil-cloud/aws";

const registry = new AgentProviderRegistry();

registry.register(new LocalStubInferenceProvider({ echoInput: true }));
registry.register(
  new BedrockInferenceProvider({
    region: process.env.AWS_REGION ?? "eu-west-2",
  }),
);

export const runtime = new AgentRuntime({
  providers: registry,
});
