export interface Env {
  DB: D1Database;
  API_SECRET_TOKEN: any;
  ALLOWED_ORIGINS: string;
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

// ========== Database Query Functions ==========

async function getCategories(db: D1Database): Promise<WorkerCategory[]> {
  const result = await db
    .prepare('SELECT id, name, slug, parent_id FROM categories ORDER BY name')
    .all<{ id: string; name: string; slug: string; parent_id: string | null }>();

  return (result.results || []).map(cat => ({
    id: cat.id,
    name: cat.name,
    slug: cat.slug,
    parentId: cat.parent_id,
  }));
}

async function getProducts(
  db: D1Database,
  page: number = 1,
  perPage: number = 20,
  categoryId?: string
): Promise<{ items: WorkerProduct[]; total: number }> {
  // Products are only in leaf categories, not in root
  // Must provide categoryId to get products
  if (!categoryId) {
    return { items: [], total: 0 };
  }

  const offset = (page - 1) * perPage;

  const result = await db
    .prepare(
      `
      SELECT
        p.id,
        p.name,
        p.description,
        p.price_cents,
        p.compare_price_cents,
        GROUP_CONCAT(DISTINCT pc.category_id) as category_ids,
        (SELECT url FROM product_images WHERE product_id = p.id AND variation_id IS NULL LIMIT 1) as image_url
      FROM products p
      LEFT JOIN product_categories pc ON p.id = pc.product_id
      WHERE EXISTS (SELECT 1 FROM product_categories pc2 WHERE pc2.product_id = p.id AND pc2.category_id = ?)
      GROUP BY p.id
      ORDER BY p.name
      LIMIT ? OFFSET ?
    `
    )
    .bind(categoryId, perPage, offset)
    .all<{
      id: string;
      name: string;
      description: string | null;
      price_cents: number;
      compare_price_cents: number | null;
      category_ids: string | null;
      image_url: string | null;
    }>();

  const countResult = await db
    .prepare(
      `
      SELECT COUNT(DISTINCT p.id) as count FROM products p
      WHERE EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)
    `
    )
    .bind(categoryId)
    .first<{ count: number }>();

  return {
    items: (result.results || []).map(p => ({
      id: p.id,
      name: p.name,
      shortDescription: p.description ? truncateText(p.description, 120) : undefined,
      priceCents: p.price_cents,
      comparePriceCents: p.compare_price_cents,
      imageUrl: p.image_url || undefined,
      categoryIds: p.category_ids ? p.category_ids.split(',') : [],
    })),
    total: countResult?.count || 0,
  };
}

async function getProductDetail(db: D1Database, productId: string): Promise<WorkerProductDetail | null> {
  const product = await db
    .prepare(
      `
      SELECT
        id, name, description, price_cents, compare_price_cents, sku
      FROM products
      WHERE id = ?
    `
    )
    .bind(productId)
    .first<{
      id: string;
      name: string;
      description: string | null;
      price_cents: number;
      compare_price_cents: number | null;
      sku: string | null;
    }>();

  if (!product) return null;

  // Get product categories
  const categoriesResult = await db
    .prepare('SELECT category_id FROM product_categories WHERE product_id = ?')
    .bind(productId)
    .all<{ category_id: string }>();

  const categoryIds = (categoriesResult.results || []).map(c => c.category_id);

  // Get product images (those with no variation_id)
  const imagesResult = await db
    .prepare('SELECT url FROM product_images WHERE product_id = ? AND variation_id IS NULL ORDER BY position')
    .bind(productId)
    .all<{ url: string }>();

  const images = (imagesResult.results || []).map(i => i.url);

  // Get variations with their data
  const variationsResult = await db
    .prepare(
      `
      SELECT
        pv.id,
        pv.sku,
        pv.name,
        pv.price_cents,
        pv.in_stock
      FROM product_variations pv
      WHERE pv.product_id = ?
      ORDER BY pv.name
    `
    )
    .bind(productId)
    .all<{
      id: string;
      sku: string;
      name: string | null;
      price_cents: number | null;
      in_stock: boolean;
    }>();

  const variants = (variationsResult.results || []).map(v => {
    // Extract size from variation name if it follows pattern "Tamanho:XXX"
    let size = '';
    if (v.name) {
      const sizeMatch = v.name.match(/Tamanho:([^;]+)/i);
      size = sizeMatch ? sizeMatch[1] : v.name;
    }

    return {
      id: v.id,
      sku: v.sku,
      size: size || '',
      priceCents: v.price_cents || product.price_cents,
      inStock: v.in_stock,
    };
  });

  return {
    id: product.id,
    name: product.name,
    description: product.description || undefined,
    shortDescription: product.description ? truncateText(product.description, 120) : undefined,
    priceCents: product.price_cents,
    comparePriceCents: product.compare_price_cents,
    imageUrl: images.length > 0 ? images[0] : undefined,
    images,
    categoryIds,
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

  // First pass: find all descendants of rootId
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

  // Find all category IDs that are parents (have children)
  const parentCategoryIds = new Set<string>();
  categories.forEach(cat => {
    if (cat.parentId && validIds.has(cat.parentId)) {
      parentCategoryIds.add(cat.parentId);
    }
  });

  // Return only leaf categories (categories that are not parents and not root)
  const result = categories.filter(
    cat => validIds.has(cat.id) && cat.id !== rootId && !parentCategoryIds.has(cat.id)
  );

  return result;
}

// ========== HTTP Handlers ==========

async function handleCategories(env: Env): Promise<Response> {
  try {
    const categories = await getCategories(env.DB);

    // Filter to only include Holila category tree (root = 12037597)
    const HOLILA_ROOT_ID = '12037597';
    const holilaCategories = filterCategoryTree(categories, HOLILA_ROOT_ID);

    return new Response(JSON.stringify(holilaCategories), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Error fetching categories:', err);
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch categories' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleProducts(env: Env, url: URL): Promise<Response> {
  try {
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const perPage = parseInt(url.searchParams.get('per_page') || '20', 10);
    const categoryId = url.searchParams.get('category_id') || undefined;

    const result = await getProducts(env.DB, page, perPage, categoryId);

    const response: WorkerProductListResponse = {
      items: result.items,
      total: result.total,
      hasMore: result.items.length === perPage,
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
    const product = await getProductDetail(env.DB, productId);

    if (!product) {
      return new Response(JSON.stringify({ error: 'Product not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(product), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Error fetching product detail:', err);
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch product detail' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
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

    if (pathname === '/debug') {
      try {
        const categoriesResult = await env.DB.prepare('SELECT COUNT(*) as count FROM categories').first<{ count: number }>();
        const productsResult = await env.DB.prepare('SELECT COUNT(*) as count FROM products').first<{ count: number }>();
        const variationsResult = await env.DB.prepare('SELECT COUNT(*) as count FROM product_variations').first<{ count: number }>();
        const imagesResult = await env.DB.prepare('SELECT COUNT(*) as count FROM product_images').first<{ count: number }>();
        const categoriesLinksResult = await env.DB.prepare('SELECT COUNT(*) as count FROM product_categories').first<{ count: number }>();

        return new Response(JSON.stringify({
          categories: categoriesResult?.count || 0,
          products: productsResult?.count || 0,
          variations: variationsResult?.count || 0,
          images: imagesResult?.count || 0,
          categoryLinks: categoriesLinksResult?.count || 0,
        }), {
          status: 200,
          headers: corsHeaders,
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), {
          status: 500,
          headers: corsHeaders,
        });
      }
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
