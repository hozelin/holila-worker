export interface Env {
  BLING_KV: KVNamespace;
  BLING_CLIENT_ID: any;
  BLING_CLIENT_SECRET: any;
  ALLOWED_ORIGINS: string;
  API_SECRET_TOKEN: any;
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// Bling API responses
interface BlingCategory {
  id: number;
  descricao: string;
  categoriaPai?: { id: number } | null;
}

interface BlingProduct {
  id: number;
  nome: string;
  descricao?: string;
  preco: number;
  precoCusto?: number;
  imageThumbnail?: string;
  imagens?: { id: number; urlImagem: string }[];
  situacao: string;
  categorias?: { id: number; descricao: string }[];
  variacoes?: BlingVariation[];
}

interface BlingVariation {
  id: number;
  nome: string;
  codigo: string;
  preco: number;
  precoCusto?: number;
  estoque?: { saldoVirtualTotal?: number };
  variacao?: {
    nome: string;
    ordem: number;
    produtoPai?: { id: number };
  };
}

// Worker response types
interface WorkerCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

interface WorkerProduct {
  id: string;
  name: string;
  shortDescription?: string;
  priceCents: number;
  comparePriceCents: number | null;
  imageUrl?: string;
  categoryIds: string[];
}

interface WorkerProductDetail extends WorkerProduct {
  description?: string;
  images: string[];
  variants: {
    id: string;
    sku: string;
    size: string;
    priceCents: number;
    inStock: boolean;
  }[];
}

interface WorkerProductListResponse {
  items: WorkerProduct[];
  total: number;
  hasMore: boolean;
}

const TOKEN_KEY = 'bling_tokens';

// ========== Token Management ==========

async function getTokens(env: Env): Promise<TokenData | null> {
  const data = await env.BLING_KV.get(TOKEN_KEY);
  return data ? (JSON.parse(data) as TokenData) : null;
}

async function saveTokens(env: Env, tokens: TokenData): Promise<void> {
  await env.BLING_KV.put(TOKEN_KEY, JSON.stringify(tokens));
}

async function refreshTokens(env: Env, refresh_token: string): Promise<TokenData> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refresh_token);

  const clientId = await env.BLING_CLIENT_ID.get();
  const clientSecret = await env.BLING_CLIENT_SECRET.get();
  const credentials = `${clientId}:${clientSecret}`;
  const encodedCredentials = btoa(credentials);

  const response = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '1.0',
      Authorization: `Basic ${encodedCredentials}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.statusText}`);
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000 - 60000,
  };
}

async function getValidAccessToken(env: Env): Promise<string> {
  let tokens = await getTokens(env);
  if (!tokens) {
    throw new Error(
      'No token found in KV. Bootstrap required: POST /auth/callback with authorization code from Bling OAuth flow'
    );
  }

  const now = Date.now();
  if (now >= tokens.expires_at) {
    tokens = await refreshTokens(env, tokens.refresh_token);
    await saveTokens(env, tokens);
  }

  return tokens.access_token;
}

// ========== Bling API Calls ==========

async function fetchCategories(accessToken: string): Promise<BlingCategory[]> {
  const response = await fetch('https://www.bling.com.br/Api/v3/categorias/produtos', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch categories: ${response.statusText}`);
  }

  const json = (await response.json()) as { data: BlingCategory[] };
  return json.data || [];
}

async function fetchProducts(
  accessToken: string,
  page: number = 1,
  perPage: number = 20,
  categoryId?: string,
  q?: string
): Promise<{ data: BlingProduct[]; total?: number }> {
  const params = new URLSearchParams();
  params.set('pagina', String(page));
  params.set('limite', String(Math.min(perPage, 100)));
  if (categoryId) params.set('categoria_id', categoryId);
  if (q) params.set('nome', q);

  const response = await fetch(
    `https://www.bling.com.br/Api/v3/produtos?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch products: ${response.statusText}`);
  }

  const json = (await response.json()) as { data: BlingProduct[] };
  return json;
}

async function fetchProductDetail(accessToken: string, productId: string): Promise<BlingProduct> {
  const response = await fetch(`https://www.bling.com.br/Api/v3/produtos/${productId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch product detail: ${response.statusText}`);
  }

  const json = (await response.json()) as { data: BlingProduct };
  const product = json.data;
  console.log(`[Bling] Product ${productId}: preco=${product.preco}, variacoes count=${product.variacoes?.length || 0}`);
  if (product.variacoes && product.variacoes.length > 0) {
    console.log(`[Bling] First variation:`, JSON.stringify(product.variacoes[0], null, 2).substring(0, 200));
  }
  return product;
}

// ========== Mappers ==========

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '');
}

function mapBlingCategoryToWorker(cat: BlingCategory): WorkerCategory {
  return {
    id: String(cat.id),
    name: cat.descricao,
    slug: slugify(cat.descricao),
    parentId: cat.categoriaPai ? String(cat.categoriaPai.id) : null,
  };
}

function mapBlingProductToWorker(product: BlingProduct): WorkerProduct {
  const imageUrl =
    product.imageThumbnail ||
    (product.imagens && product.imagens.length > 0 ? product.imagens[0].urlImagem : undefined);

  return {
    id: String(product.id),
    name: product.nome,
    shortDescription: product.descricao ? truncateText(product.descricao, 120) : undefined,
    priceCents: Math.round(product.preco * 100),
    comparePriceCents: null,
    imageUrl,
    categoryIds: (product.categorias || []).map(cat => String(cat.id)),
  };
}

function mapBlingProductDetail(product: BlingProduct): WorkerProductDetail {
  const imageUrl =
    product.imageThumbnail ||
    (product.imagens && product.imagens.length > 0 ? product.imagens[0].urlImagem : undefined);

  // Extract images from midia.imagens.internas if available
  const images: string[] = [];
  if ((product as any).midia?.imagens?.internas) {
    const internasImages = (product as any).midia.imagens.internas as Array<{ link: string }>;
    images.push(...internasImages.map(img => img.link));
  }

  // Fallback to old format
  if (images.length === 0 && product.imagens) {
    images.push(...product.imagens.map(img => img.urlImagem));
  }

  if (imageUrl && !images.includes(imageUrl)) {
    images.unshift(imageUrl);
  }

  console.log(`DEBUG: Product ID ${product.id} has ${product.variacoes?.length || 0} variations`);

  const variants = product.variacoes
    ? product.variacoes.map(v => {
        // Parse variacao.nome like "Tamanho:G;Cor:Verde" to extract size
        let size = '';
        if (v.variacao?.nome) {
          const sizeMatch = v.variacao.nome.match(/Tamanho:([^;]+)/i);
          size = sizeMatch ? sizeMatch[1] : v.variacao.nome;
        }

        return {
          id: String(v.id),
          sku: v.codigo || `SKU-${v.id}`,
          size: size || '',
          priceCents: Math.round(v.preco * 100),
          inStock: (v.estoque?.saldoVirtualTotal || 0) > 0,
        };
      })
    : [];

  return {
    id: String(product.id),
    name: product.nome,
    description: product.descricao,
    shortDescription: product.descricao ? truncateText(product.descricao, 120) : undefined,
    priceCents: Math.round(product.preco * 100),
    comparePriceCents: null,
    imageUrl,
    images,
    categoryIds: (product.categorias || []).map(cat => String(cat.id)),
    variants,
  };
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.substring(0, lastSpace) + '…' : truncated + '…';
}

function filterCategoryTree(
  categories: WorkerCategory[],
  rootId: string
): WorkerCategory[] {
  // Find all category IDs that descend from rootId
  const validIds = new Set<string>();

  // First pass: find all direct children of rootId
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    validIds.add(parentId);

    const children = categories.filter(cat => String(cat.parentId) === String(parentId));
    children.forEach(child => {
      if (!validIds.has(child.id)) {
        queue.push(child.id);
      }
    });
  }

  console.log('Valid category IDs:', Array.from(validIds));

  // Return only categories that are in the valid set (excluding root itself)
  const result = categories.filter(cat => validIds.has(cat.id) && cat.id !== rootId);
  console.log('Filtered categories count:', result.length);
  return result;
}

// ========== Auth Callback Handler ==========

async function handleAuthCallback(env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code) {
    return new Response(
      JSON.stringify({ error: 'Missing authorization code' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const clientId = await env.BLING_CLIENT_ID.get();
    const clientSecret = await env.BLING_CLIENT_SECRET.get();
    const callbackUrl = 'https://holila-catalog-worker.contato-274.workers.dev/auth/callback';

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', callbackUrl);

    const credentials = `${clientId}:${clientSecret}`;
    const encodedCredentials = btoa(credentials);

    const response = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '1.0',
        Authorization: `Basic ${encodedCredentials}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return new Response(
        JSON.stringify({
          error: `Token exchange failed: ${response.statusText}`,
          details: errorBody,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const json = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const tokens: TokenData = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + json.expires_in * 1000 - 60000,
    };

    await saveTokens(env, tokens);

    return new Response(
      JSON.stringify({
        message: 'Token salvo com sucesso! O Worker está pronto para usar.',
        expiresAt: new Date(tokens.expires_at).toISOString(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Auth callback error:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Authentication failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ========== HTTP Handlers ==========

async function handleCategories(env: Env): Promise<Response> {
  try {
    const accessToken = await getValidAccessToken(env);
    const categories = await fetchCategories(accessToken);
    const mapped = categories.map(mapBlingCategoryToWorker);

    // Filter to only include Holila category tree (root = 12037597)
    const HOLILA_ROOT_ID = '12037597';
    const holilaCategories = filterCategoryTree(mapped, HOLILA_ROOT_ID);

    return new Response(JSON.stringify(holilaCategories), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Error fetching categories:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Failed to fetch categories' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

async function handleProducts(env: Env, url: URL): Promise<Response> {
  try {
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const perPage = parseInt(url.searchParams.get('per_page') || '20', 10);
    const categoryId = url.searchParams.get('category_id') || undefined;
    const q = url.searchParams.get('q') || undefined;

    const accessToken = await getValidAccessToken(env);
    const result = await fetchProducts(accessToken, page, perPage, categoryId, q);

    // Filter to only parent products (idProdutoPai is null/undefined)
    const parentProducts = result.data.filter((product: any) => !product.idProdutoPai);
    const mapped = parentProducts.map(mapBlingProductToWorker);

    console.log(`[Products] Fetched ${result.data.length} total, ${parentProducts.length} parents`);

    const response: WorkerProductListResponse = {
      items: mapped,
      total: parentProducts.length,
      hasMore: mapped.length === perPage,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Error fetching products:', err);
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch products' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleProductDetail(env: Env, productId: string): Promise<Response> {
  try {
    const accessToken = await getValidAccessToken(env);
    const product = await fetchProductDetail(accessToken, productId);
    const mapped = mapBlingProductDetail(product);

    return new Response(JSON.stringify(mapped), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Error fetching product detail:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Failed to fetch product detail' }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// ========== Main Handler ==========

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const origin = req.headers.get('origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(o => o.trim());

    // Auth callback endpoint (no Bearer token required, origin validation skipped for OAuth redirects)
    if (pathname === '/auth/callback' && req.method === 'GET') {
      return handleAuthCallback(env, url);
    }

    // Auth validation for catalog endpoints
    const authHeader = req.headers.get('Authorization');
    const apiSecretToken = await env.API_SECRET_TOKEN.get();
    const expectedToken = `Bearer ${apiSecretToken}`;
    if (authHeader !== expectedToken) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // CORS setup

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : '',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json',
    };

    if (req.method === 'OPTIONS') {
      if (!allowedOrigins.includes(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (!allowedOrigins.includes(origin)) {
      return new Response(JSON.stringify({ error: 'Forbidden - CORS' }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    // Catalog endpoints (require auth + GET method)
    if (req.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: corsHeaders,
      });
    }

    if (pathname === '/categories') {
      const response = await handleCategories(env);
      return new Response(response.body, {
        status: response.status,
        headers: corsHeaders,
      });
    }

    if (pathname === '/products') {
      const response = await handleProducts(env, url);
      return new Response(response.body, {
        status: response.status,
        headers: corsHeaders,
      });
    }

    const productMatch = pathname.match(/^\/products\/(.+)$/);
    if (productMatch) {
      const productId = productMatch[1];
      const response = await handleProductDetail(env, productId);
      return new Response(response.body, {
        status: response.status,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: corsHeaders,
    });
  },
};
