# Holila Catalog Worker

Cloudflare Worker que expõe os produtos e categorias do Bling ERP como uma API REST protegida por Bearer token.

## Setup

### 1. Instalar dependências

```bash
pnpm install
```

### 2. Configurar Cloudflare

#### KV Namespace
```bash
wrangler kv:namespace create BLING_KV --preview BLING_KV_PREVIEW
```

Copie os IDs para `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "BLING_KV"
id = "<ID_AQUI>"
preview_id = "<PREVIEW_ID_AQUI>"
```

#### Secrets Store

No dashboard Cloudflare, crie um **Secrets Store** (ou use um existente) com as seguintes secrets:

- `BLING_CLIENT_ID` — obtido do Bling Partner Portal
- `BLING_CLIENT_SECRET` — obtido do Bling Partner Portal
- `HOLILA_WORKER_TOKEN` — token compartilhado que o app iOS vai usar (ex: gere uma string aleatória com `openssl rand -hex 32`)

No `wrangler.toml`, configure:
```toml
secrets_store_secrets = [
  { binding = "BLING_CLIENT_ID", store_id = "...", secret_name = "BLING_CLIENT_ID" },
  { binding = "BLING_CLIENT_SECRET", store_id = "...", secret_name = "BLING_CLIENT_SECRET" },
  { binding = "API_SECRET_TOKEN", store_id = "...", secret_name = "HOLILA_WORKER_TOKEN" },
]
```

#### Token Bling inicial

O Worker precisa de um token Bling no KV para começar. Faça o primeiro login (bootstrap) com seu painel do Bling:

1. Vá para o painel do Bling
2. Copie o `access_token` e `refresh_token` de uma requisição autenticada
3. Salve no KV manualmente:

```bash
wrangler kv:key put --binding BLING_KV \
  bling_tokens '{"access_token":"seu_token_aqui","refresh_token":"seu_refresh_aqui","expires_at":'$(( $(date +%s) * 1000 + 3600000 ))'}' \
  --path wrangler.toml
```

Ou use a CLI do Cloudflare para configurar.

### 3. Variáveis de ambiente

**`wrangler.toml`** — `[vars]`:
```toml
[vars]
ALLOWED_ORIGINS = "holila://app"
```

(iOS app via deep link, ou `http://localhost:8787` para testes locais)

## Endpoints

### GET /categories

Retorna lista de categorias do Bling.

**Request:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://holila-catalog-worker.workers.dev/categories
```

**Response:**
```json
[
  { "id": "123", "name": "Meninas", "slug": "meninas", "parentId": null },
  { "id": "124", "name": "Meninos", "slug": "meninos", "parentId": null }
]
```

### GET /products

Retorna lista paginada de produtos.

**Query params:**
- `page` (default: 1)
- `per_page` (default: 20, max: 100)
- `category_id` — filtro por categoria
- `q` — busca por nome

**Request:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://holila-catalog-worker.workers.dev/products?page=1&per_page=10&category_id=123"
```

**Response:**
```json
{
  "items": [
    {
      "id": "456",
      "name": "Vestido Infantil",
      "shortDescription": "...",
      "priceCents": 8990,
      "comparePriceCents": null,
      "imageUrl": "https://...",
      "categoryIds": ["123"]
    }
  ],
  "total": 21,
  "hasMore": false
}
```

### GET /products/:id

Retorna detalhe completo de um produto.

**Request:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://holila-catalog-worker.workers.dev/products/456
```

**Response:**
```json
{
  "id": "456",
  "name": "Vestido Infantil",
  "description": "Descrição completa...",
  "priceCents": 8990,
  "comparePriceCents": null,
  "imageUrl": "https://...",
  "images": ["https://img1...", "https://img2..."],
  "categoryIds": ["123"],
  "variants": [
    { "id": "v1", "sku": "VF-M", "size": "M", "priceCents": 8990, "inStock": true }
  ]
}
```

## Desenvolvimento

### Local dev
```bash
pnpm run dev
# Abre em http://localhost:8787
```

Teste endpoints localmente:
```bash
curl -H "Authorization: Bearer test-token" \
  http://localhost:8787/categories
```

(Você pode usar qualquer token em dev — a validação é desabilitada ou usa um padrão)

### Build
```bash
pnpm run build
```

### Deploy
```bash
pnpm run deploy
```

## Troubleshooting

**"Tokens not found in KV"**
- Você precisa inicializar o KV com um token Bling válido (bootstrap)
- Ou o token expirou e não há `refresh_token` para renovar

**"Token refresh failed"**
- Verifique se `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET` estão corretos
- Verifique se o `refresh_token` no KV é válido

**CORS error no app iOS**
- Verifique `ALLOWED_ORIGINS` em `wrangler.toml` — deve incluir o scheme do app (ex: `holila://app`)

## Arquitetura

- **Auth**: Bearer token (validado em toda requisição)
- **Bling OAuth**: Token armazenado em KV, refresh automático quando expira
- **Preços**: em centavos (int) para evitar arredondamento
- **Imagens**: URLs CDN do Bling, mapeadas diretamente
- **Variações**: extraídas como `variants[]`, com suporte a tamanho
