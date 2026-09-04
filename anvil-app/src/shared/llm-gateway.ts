export const LLM_GATEWAY_API_URL = 'https://api.llmgateway.io/v1';
export const LLM_GATEWAY_KEY_ENV = 'LLMGATEWAY_API_KEY';
export const LLM_GATEWAY_SOURCE = 'anvil';

export function getLlmGatewayCodexConfigArgs(): string[] {
  return [
    'app-server',
    '-c',
    'model_provider="llmgateway"',
    '-c',
    'model_providers.llmgateway.name="LLM Gateway"',
    '-c',
    `model_providers.llmgateway.base_url="${LLM_GATEWAY_API_URL}"`,
    '-c',
    `model_providers.llmgateway.env_key="${LLM_GATEWAY_KEY_ENV}"`,
    '-c',
    'model_providers.llmgateway.wire_api="responses"',
    '-c',
    `model_providers.llmgateway.http_headers={ x-source = "${LLM_GATEWAY_SOURCE}" }`,
  ];
}
