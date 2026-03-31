import {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class RunPodApi implements ICredentialType {
	name = 'runPodApi';
	displayName = 'RunPod API';
	documentationUrl = 'https://docs.runpod.io/reference/authentication';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			placeholder: 'rp_xxxxxxxxxxxxxxxx',
			required: true,
			description: 'Tu API Key de RunPod. La encuentras en tu perfil en runpod.io',
		},
		{
			displayName: 'Endpoint ID',
			name: 'endpointId',
			type: 'string',
			default: '',
			placeholder: 'rneub911ctxubr',
			required: true,
			description: 'El ID de tu Serverless Endpoint de RunPod',
		},
	];
}
