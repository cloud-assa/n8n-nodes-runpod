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
	useSyncEndpoint?: boolean;
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

interface SyncResult {
	text?: string;
	jobId?: string;
}

class RunPodLLM extends BaseChatModel {
	private apiKey: string;
	private endpointId: string;
	private modelName: string;
	private temperature: number;
	private maxTokens: number;
	private useSyncEndpoint: boolean;
	private maxWaitTime: number;

	constructor(params: RunPodLLMParams) {
		super(params);
		this.apiKey = params.apiKey;
		this.endpointId = params.endpointId;
		this.modelName = params.modelName ?? '';
		this.temperature = params.temperature ?? 0.7;
		this.maxTokens = params.maxTokens ?? 0;
		this.useSyncEndpoint = params.useSyncEndpoint !== false; // true by default
		this.maxWaitTime = params.maxWaitTime ?? 300;
	}

	_llmType(): string {
		return 'runpod';
	}

	// ── Message formatting ───────────────────────────────────────────────────
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

	// ── Output extraction (handles all RunPod response shapes) ───────────────
	private extractText(output: unknown): string {
		if (output === null || output === undefined) {
			return '';
		}

		if (typeof output === 'string') {
			return output;
		}

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
			// Try to extract from choices (OpenAI-compatible workers)
			if (typeof output[0] === 'object' && (output[0] as Record<string, unknown>).choices) {
				return this.extractText(output[0]);
			}
			return JSON.stringify(output);
		}

		if (typeof output === 'object') {
			const obj = output as Record<string, unknown>;
			// OpenAI-compatible response shape
			if (Array.isArray(obj.choices) && obj.choices.length > 0) {
				const choice = obj.choices[0] as Record<string, unknown>;
				const message = choice.message as Record<string, unknown> | undefined;
				if (message?.content) return String(message.content);
				if (choice.text) return String(choice.text);
			}
			if (typeof obj.text === 'string') return obj.text;
			if (typeof obj.content === 'string') return obj.content;
			if (typeof obj.response === 'string') return obj.response;
			if (typeof obj.generated_text === 'string') return obj.generated_text;
			// Recurse into nested output field
			if (obj.output !== undefined && obj.output !== null) {
				return this.extractText(obj.output);
			}
		}

		return JSON.stringify(output);
	}

	// ── Fetch with AbortController timeout ──────────────────────────────────
	private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(url, { ...options, signal: controller.signal });
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// ── Build request body ───────────────────────────────────────────────────
	private buildBody(prompt: string, formattedMessages: RunPodMessage[]): Record<string, unknown> {
		const body: Record<string, unknown> = {
			input: {
				prompt,
				messages: formattedMessages,
				temperature: this.temperature,
			} as Record<string, unknown>,
		};
		// Only send max_tokens if the user set a value > 0; 0 means "let the model decide"
		if (this.maxTokens > 0) (body.input as Record<string, unknown>).max_tokens = this.maxTokens;
		if (this.modelName) (body.input as Record<string, unknown>).model = this.modelName;
		return body;
	}

	// ── Strategy 1: /runsync — single request, server waits up to 90 s ──────
	private async tryRunSync(body: Record<string, unknown>, headers: Record<string, string>): Promise<SyncResult | null> {
		const url = `https://api.runpod.ai/v2/${this.endpointId}/runsync`;
		// Give network 5 s of buffer beyond the server-side 90 s limit
		const res = await this.fetchWithTimeout(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		}, 95000);

		if (!res.ok) {
			throw new Error(`RunPod /runsync ${res.status}: ${await res.text()}`);
		}
		const data = await res.json() as RunPodStatusResponse & { id?: string };

		if (data.status === 'COMPLETED') return { text: this.extractText(data.output) };
		if (data.status === 'FAILED' || data.status === 'CANCELLED') {
			throw new Error(`RunPod job failed: ${data.error ?? data.status}`);
		}
		// IN_QUEUE / IN_PROGRESS — server returned early with a job ID
		if (data.id) return { jobId: data.id };
		return null;
	}

	// ── Strategy 2: /run + adaptive polling ─────────────────────────────────
	private async submitAsync(body: Record<string, unknown>, headers: Record<string, string>): Promise<string> {
		const url = `https://api.runpod.ai/v2/${this.endpointId}/run`;
		const res = await this.fetchWithTimeout(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		}, 30000);
		if (!res.ok) {
			throw new Error(`RunPod /run ${res.status}: ${await res.text()}`);
		}
		const data = await res.json() as RunPodJobResponse;
		if (!data.id) throw new Error('RunPod did not return a job ID');
		return data.id;
	}

	private async pollForResult(jobId: string, headers: Record<string, string>): Promise<string> {
		const url = `https://api.runpod.ai/v2/${this.endpointId}/status/${jobId}`;
		const deadline = Date.now() + this.maxWaitTime * 1000;
		// Adaptive interval: 1 s → 5 s (grows 20 % per check)
		let interval = 1000;
		let networkRetries = 0;

		while (Date.now() < deadline) {
			await new Promise<void>((r) => setTimeout(r, interval));

			let data: RunPodStatusResponse;
			try {
				const res = await this.fetchWithTimeout(url, { headers } as RequestInit, 15000);
				if (!res.ok) {
					if (res.status >= 500 && networkRetries < 3) {
						networkRetries++;
						continue;
					}
					throw new Error(`RunPod status ${res.status}: ${await res.text()}`);
				}
				data = await res.json() as RunPodStatusResponse;
				networkRetries = 0;
			} catch (err) {
				if (networkRetries < 3) {
					networkRetries++;
					interval = Math.min(interval * 2, 5000);
					continue;
				}
				throw err;
			}

			if (data.status === 'COMPLETED') return this.extractText(data.output);
			if (data.status === 'FAILED' || data.status === 'CANCELLED') {
				throw new Error(`RunPod job failed: ${data.error ?? data.status}`);
			}
			if (data.status === 'TIMED_OUT') {
				throw new Error('RunPod job timed out on the server side');
			}

			interval = Math.min(Math.floor(interval * 1.2), 5000);
		}
		throw new Error(
			`RunPod timeout: job ${jobId} did not complete within ${this.maxWaitTime} s`,
		);
	}

	// ── Main entry point ─────────────────────────────────────────────────────
	async _generate(
		messages: BaseMessage[],
		_options: this['ParsedCallOptions'],
		_runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		const { prompt, messages: fmt } = this.formatMessages(messages);
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		};
		const body = this.buildBody(prompt, fmt);
		let text: string;

		if (this.useSyncEndpoint) {
			// Fast path: single HTTP call via /runsync
			let syncResult: SyncResult | null;
			try {
				syncResult = await this.tryRunSync(body, headers);
			} catch (err) {
				// AbortError = runsync timed out locally → fall back to async
				if ((err as Error).name === 'AbortError' || String((err as Error).message).includes('abort')) {
					syncResult = null;
				} else {
					throw err;
				}
			}

			if (syncResult?.text !== undefined) {
				text = syncResult.text;
			} else if (syncResult?.jobId) {
				// runsync gave us a job ID — continue polling
				text = await this.pollForResult(syncResult.jobId, headers);
			} else {
				// Full fallback: submit async + poll
				const jobId = await this.submitAsync(body, headers);
				text = await this.pollForResult(jobId, headers);
			}
		} else {
			const jobId = await this.submitAsync(body, headers);
			text = await this.pollForResult(jobId, headers);
		}

		const generation: ChatGeneration = { text, message: new AIMessage(text) };
		return { generations: [generation] };
	}
}

// ─── n8n Node Definition ─────────────────────────────────────────────────────

export class RunPodChatModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'RunPod Chat Model',
		name: 'runPodChatModel',
		icon: 'file:daat.png',
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
					'Nombre del modelo a usar. D\u00e9jalo vac\u00edo si tu worker ya tiene el modelo fijo.',
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
					minValue: 0,
				},
				default: 0,
				description: 'N\u00famero m\u00e1ximo de tokens en la respuesta. Usa 0 para dejar que el modelo decida (sin l\u00edmite fijo).',
			},
			{
				displayName: 'Use Sync Endpoint',
				name: 'useSyncEndpoint',
				type: 'boolean',
				default: true,
				description: 'Whether to use /runsync (faster, single request) instead of /run + polling. Disable only if your worker does not support it.',
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
				description: 'Tiempo m\u00e1ximo de espera en segundos antes de dar timeout (aplica solo al modo polling)',
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('runPodApi');

		const modelName = this.getNodeParameter('modelName', itemIndex, '') as string;
		const temperature = this.getNodeParameter('temperature', itemIndex, 0.7) as number;
		const maxTokens = this.getNodeParameter('maxTokens', itemIndex, 0) as number;
		const useSyncEndpoint = this.getNodeParameter('useSyncEndpoint', itemIndex, true) as boolean;
		const maxWaitTime = this.getNodeParameter('maxWaitTime', itemIndex, 300) as number;

		const model = new RunPodLLM({
			apiKey: credentials.apiKey as string,
			endpointId: credentials.endpointId as string,
			modelName,
			temperature,
			maxTokens,
			useSyncEndpoint,
			maxWaitTime,
		});

		return { response: model };
	}
}
