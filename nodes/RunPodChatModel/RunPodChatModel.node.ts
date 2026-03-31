import {
	ISupplyDataFunctions,
	INodeType,
	INodeTypeDescription,
	SupplyData,
} from 'n8n-workflow';

import {
	BaseChatModel,
	BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';

import {
	BaseMessage,
	AIMessage,
	HumanMessage,
	SystemMessage,
} from '@langchain/core/messages';

import {
	ChatResult,
	ChatGeneration,
} from '@langchain/core/outputs';

import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

// ─── RunPod LLM Core ─────────────────────────────────────────────────────────

interface RunPodLLMParams extends BaseChatModelParams {
	apiKey: string;
	endpointId: string;
	modelName?: string;
	temperature?: number;
	maxTokens?: number;
	pollingInterval?: number;
	maxWaitTime?: number;
}

interface RunPodMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

interface RunPodJobResponse {
	id: string;
	status: string;
}

interface RunPodStatusResponse {
	id: string;
	status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
	output?: unknown;
	error?: string;
}

class RunPodLLM extends BaseChatModel {
	private apiKey: string;
	private endpointId: string;
	private modelName: string;
	private temperature: number;
	private maxTokens: number;
	private pollingInterval: number;
	private maxWaitTime: number;

	constructor(params: RunPodLLMParams) {
		super(params);
		this.apiKey = params.apiKey;
		this.endpointId = params.endpointId;
		this.modelName = params.modelName ?? '';
		this.temperature = params.temperature ?? 0.7;
		this.maxTokens = params.maxTokens ?? 1024;
		this.pollingInterval = params.pollingInterval ?? 2;
		this.maxWaitTime = params.maxWaitTime ?? 300;
	}

	_llmType(): string {
		return 'runpod';
	}

	private formatMessages(messages: BaseMessage[]): { prompt: string; messages: RunPodMessage[] } {
		const formatted: RunPodMessage[] = messages.map((msg) => {
			let role: 'system' | 'user' | 'assistant';
			if (msg instanceof SystemMessage) {
				role = 'system';
			} else if (msg instanceof HumanMessage) {
				role = 'user';
			} else if (msg instanceof AIMessage) {
				role = 'assistant';
			} else {
				role = 'user';
			}
			return { role, content: String(msg.content) };
		});

		const promptParts = formatted.map((m) => {
			if (m.role === 'system') return `System: ${m.content}`;
			if (m.role === 'user') return `User: ${m.content}`;
			return `Assistant: ${m.content}`;
		});

		return {
			prompt: promptParts.join('\n'),
			messages: formatted,
		};
	}

	private extractText(output: unknown): string {
		if (output === null || output === undefined) {
			return '';
		}

		// String directo
		if (typeof output === 'string') {
			return output;
		}

		// Array
		if (Array.isArray(output)) {
			if (output.length === 0) return '';
			const first = output[0];
			if (typeof first === 'string') return first;
			if (typeof first === 'object' && first !== null) {
				const obj = first as Record<string, unknown>;
				if (typeof obj.generated_text === 'string') return obj.generated_text;
				if (typeof obj.text === 'string') return obj.text;
				if (typeof obj.content === 'string') return obj.content;
			}
			return JSON.stringify(output);
		}

		// Objeto
		if (typeof output === 'object') {
			const obj = output as Record<string, unknown>;
			if (typeof obj.text === 'string') return obj.text;
			if (typeof obj.content === 'string') return obj.content;
			if (typeof obj.response === 'string') return obj.response;
			if (typeof obj.output === 'string') return obj.output;
			if (typeof obj.generated_text === 'string') return obj.generated_text;
			// Recurse into nested output field
			if (obj.output !== undefined && obj.output !== null) {
				return this.extractText(obj.output);
			}
		}

		// Fallback
		return JSON.stringify(output);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async _generate(
		messages: BaseMessage[],
		_options: this['ParsedCallOptions'],
		_runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		const { prompt, messages: formattedMessages } = this.formatMessages(messages);

		const runUrl = `https://api.runpod.ai/v2/${this.endpointId}/run`;
		const headers = {
			'Authorization': `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		};

		const body: Record<string, unknown> = {
			input: {
				prompt,
				messages: formattedMessages,
				temperature: this.temperature,
				max_tokens: this.maxTokens,
			},
		};

		if (this.modelName) {
			(body.input as Record<string, unknown>).model = this.modelName;
		}

		// Enviar job
		const submitRes = await fetch(runUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});

		if (!submitRes.ok) {
			const errText = await submitRes.text();
			throw new Error(`RunPod error ${submitRes.status}: ${errText}`);
		}

		const jobData = (await submitRes.json()) as RunPodJobResponse;
		const jobId = jobData.id;

		if (!jobId) {
			throw new Error('RunPod no devolvió job ID');
		}

		// Polling
		const statusUrl = `https://api.runpod.ai/v2/${this.endpointId}/status/${jobId}`;
		const maxAttempts = Math.floor(this.maxWaitTime / this.pollingInterval);

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			await this.sleep(this.pollingInterval * 1000);

			const statusRes = await fetch(statusUrl, { headers });

			if (!statusRes.ok) {
				const errText = await statusRes.text();
				throw new Error(`RunPod error ${statusRes.status}: ${errText}`);
			}

			const statusData = (await statusRes.json()) as RunPodStatusResponse;

			if (statusData.status === 'COMPLETED') {
				const text = this.extractText(statusData.output);
				const generation: ChatGeneration = {
					text,
					message: new AIMessage(text),
				};
				return { generations: [generation] };
			}

			if (statusData.status === 'FAILED' || statusData.status === 'CANCELLED') {
				throw new Error(`RunPod job falló: ${statusData.error ?? statusData.status}`);
			}

			// IN_QUEUE, IN_PROGRESS, TIMED_OUT → seguir esperando o lanzar
			if (statusData.status === 'TIMED_OUT') {
				throw new Error(`RunPod job falló: TIMED_OUT en el servidor`);
			}
		}

		throw new Error(
			`RunPod timeout: el job ${jobId} no terminó en ${this.maxWaitTime} segundos`,
		);
	}
}

// ─── n8n Node Definition ─────────────────────────────────────────────────────

export class RunPodChatModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'RunPod Chat Model',
		name: 'runPodChatModel',
		icon: 'file:runpod.svg',
		group: ['transform'],
		version: 1,
		description: 'Conecta tu modelo de RunPod Serverless al Basic LLM Chain y AI Agent',
		defaults: {
			name: 'RunPod Chat Model',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.runpod.io/reference/runsync',
					},
				],
			},
		},
		inputs: [],
		outputs: ['ai_languageModel' as never],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'runPodApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Model Name',
				name: 'modelName',
				type: 'string',
				default: '',
				placeholder: 'meta-llama/Llama-3.1-8B-Instruct',
				description:
					'Nombre del modelo a usar. Déjalo vacío si tu worker ya tiene el modelo fijo.',
			},
			{
				displayName: 'Temperature',
				name: 'temperature',
				type: 'number',
				typeOptions: {
					minValue: 0,
					maxValue: 2,
					numberStepSize: 0.1,
				},
				default: 0.7,
				description: 'Controla la aleatoriedad de las respuestas (0 = determinista, 2 = muy creativo)',
			},
			{
				displayName: 'Max Tokens',
				name: 'maxTokens',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 32768,
				},
				default: 1024,
				description: 'Número máximo de tokens en la respuesta',
			},
			{
				displayName: 'Polling Interval (seconds)',
				name: 'pollingInterval',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 30,
				},
				default: 2,
				description: 'Segundos entre cada check de status del job en RunPod',
			},
			{
				displayName: 'Max Wait Time (seconds)',
				name: 'maxWaitTime',
				type: 'number',
				typeOptions: {
					minValue: 10,
					maxValue: 600,
				},
				default: 300,
				description: 'Tiempo máximo de espera en segundos antes de dar timeout',
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('runPodApi');

		const modelName = this.getNodeParameter('modelName', itemIndex, '') as string;
		const temperature = this.getNodeParameter('temperature', itemIndex, 0.7) as number;
		const maxTokens = this.getNodeParameter('maxTokens', itemIndex, 1024) as number;
		const pollingInterval = this.getNodeParameter('pollingInterval', itemIndex, 2) as number;
		const maxWaitTime = this.getNodeParameter('maxWaitTime', itemIndex, 300) as number;

		const model = new RunPodLLM({
			apiKey: credentials.apiKey as string,
			endpointId: credentials.endpointId as string,
			modelName,
			temperature,
			maxTokens,
			pollingInterval,
			maxWaitTime,
		});

		return { response: model };
	}
}
