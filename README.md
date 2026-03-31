# n8n-nodes-runpod

Nodo comunitario de n8n para conectar modelos LLM desplegados en **RunPod Serverless** directamente a los nodos **Basic LLM Chain** y **AI Agent**.

Sin dependencias de OpenAI. 100% API nativa de RunPod.

## Instalación

1. Abre n8n → **Settings** → **Community Nodes**
2. Click en **Install**
3. Escribe: `n8n-nodes-runpod`
4. Click **Install**
5. Reinicia n8n

## Configuración de credenciales

1. En n8n ve a **Credentials** → **New**
2. Busca **RunPod API**
3. Rellena:
   - **API Key**: tu clave de RunPod (la encuentras en [runpod.io](https://runpod.io) → perfil → API Keys)
   - **Endpoint ID**: el ID de tu Serverless Endpoint (ej: `rneub911ctxubr`)

## Uso

```
Chat Trigger → Basic LLM Chain ← RunPod Chat Model
                     ↓
               (respuesta al usuario)
```

O con AI Agent:

```
Chat Trigger → AI Agent ← RunPod Chat Model
                  ↓
            (herramientas, memoria, etc.)
```

## Parámetros

| Parámetro | Descripción | Default |
|-----------|-------------|---------|
| Model Name | Nombre del modelo (ej: `meta-llama/Llama-3.1-8B-Instruct`). Déjalo vacío si tu worker ya lo tiene fijo. | vacío |
| Temperature | Aleatoriedad de las respuestas (0 = determinista, 2 = muy creativo) | 0.7 |
| Max Tokens | Número máximo de tokens en la respuesta | 1024 |
| Polling Interval | Segundos entre cada check de status del job | 2 |
| Max Wait Time | Tiempo máximo de espera en segundos | 300 |

## Formatos de output soportados

El nodo detecta automáticamente el formato que devuelve tu worker:

- String directo: `"respuesta"`
- `{ text: "respuesta" }`
- `{ content: "respuesta" }`
- `{ response: "respuesta" }`
- `{ output: "respuesta" }`
- `{ generated_text: "respuesta" }`
- `["respuesta"]`
- `[{ generated_text: "respuesta" }]`

## Troubleshooting

**El nodo no aparece en Basic LLM Chain**
- Verifica que instalaste correctamente con `npm install n8n-nodes-runpod`
- Reinicia n8n completamente
- El nodo aparece en la categoría **Language Models**

**RunPod error 401**
- Tu API Key es incorrecta o ha expirado
- Genera una nueva en runpod.io → Settings → API Keys

**RunPod error 404**
- El Endpoint ID no existe o está mal escrito
- Verifica en runpod.io → Serverless → tus endpoints

**RunPod timeout: el job no terminó en X segundos**
- Tu modelo tardó más de lo esperado en responder
- Aumenta **Max Wait Time** (máximo 600 segundos)
- Verifica que tu endpoint tiene workers disponibles (no en estado "idle" con 0 workers)

**RunPod job falló**
- El worker lanzó un error interno
- Revisa los logs de tu endpoint en RunPod
- Verifica que el formato de input que espera tu worker es compatible

## Licencia

MIT
