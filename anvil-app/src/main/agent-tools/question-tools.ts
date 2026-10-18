import type { AgentUIQuestion, AgentUIQuestionOption } from '../../shared/agent-ui-intents.js';
import { askAgentQuestion } from '../services/agent-question.service.js';
import { formatSchemaErrors, validateJsonSchema } from '../surfaces/validate.js';
import {
  AgentToolError,
  textResult,
  type AgentToolDefinition,
  type AgentToolProvider,
} from './dispatch.js';

const questionTool: AgentToolDefinition = {
  name: 'question_ask',
  title: 'Ask a question',
  description:
    'Ask the user a structured question in Anvil. Works in every provider and mode. The call waits for their answers and returns them directly. Prefer one concise question; group up to four related decisions. Do not repeat it in prose or poll for answers. Cancellation or expiry returns a status without answers. Never request passwords, tokens or other secrets here.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      questions: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'kind', 'question'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 80 },
            kind: {
              type: 'string',
              enum: ['single_choice', 'multiple_choice', 'yes_no', 'free_text'],
            },
            question: { type: 'string', minLength: 1, maxLength: 1000 },
            context: { type: 'string', maxLength: 2000 },
            required: { type: 'boolean', default: true },
            allowOther: {
              type: 'boolean',
              description: 'Allow a custom answer to a single-choice question.',
            },
            options: {
              type: 'array',
              maxItems: 9,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'label'],
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 80 },
                  label: { type: 'string', minLength: 1, maxLength: 200 },
                  description: { type: 'string', maxLength: 1000 },
                  recommended: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  },
};

type QuestionInput = Pick<AgentUIQuestion, 'id' | 'question' | 'context' | 'allowOther'> & {
  kind: Exclude<AgentUIQuestion['kind'], 'approval'>;
  required?: boolean;
  options?: Omit<AgentUIQuestionOption, 'value'>[];
};

export const questionToolProvider: AgentToolProvider = {
  id: 'questions',
  tools: () => [questionTool],
  async call(ctx, name, args, signal) {
    if (name !== questionTool.name) return undefined;
    const errors = validateJsonSchema(questionTool.inputSchema, args, 'args');
    if (errors.length) throw new AgentToolError(formatSchemaErrors(errors), 'invalid-params');
    const input = args as unknown as { title?: string; questions: QuestionInput[] };
    if (!input.questions.length)
      throw new AgentToolError('Include at least one question.', 'invalid-params');
    const ids = new Set<string>();
    const questions = input.questions.map((q): AgentUIQuestion => {
      if (!q.id.trim() || ids.has(q.id) || !q.question.trim()) {
        throw new AgentToolError('Questions need unique IDs and non-empty text.', 'invalid-params');
      }
      ids.add(q.id);
      const choice = q.kind === 'single_choice' || q.kind === 'multiple_choice';
      const { options: inputOptions, ...fields } = q;
      const options = inputOptions?.map((option) => ({ ...option, value: option.id }));
      if (
        choice &&
        (!options ||
          options.length < 2 ||
          new Set(options.map((o) => o.id)).size !== options.length ||
          options.some((o) => !o.id.trim() || !o.label.trim()))
      ) {
        throw new AgentToolError(
          'Choice questions need 2–9 options with unique IDs and non-empty labels.',
          'invalid-params',
        );
      }
      if ((!choice && options?.length) || (q.allowOther && q.kind !== 'single_choice')) {
        throw new AgentToolError(
          'Options require a choice question; allowOther requires single_choice.',
          'invalid-params',
        );
      }
      return {
        ...fields,
        required: q.required !== false,
        allowCancel: true,
        ...(options ? { options } : {}),
      };
    });
    const result = await askAgentQuestion(
      ctx,
      {
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        questions,
      },
      signal,
    );
    return textResult(JSON.stringify(result), { ...result });
  },
};
