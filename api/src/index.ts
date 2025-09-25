// api/src/index.ts
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { PrismaClient } from './generated/prisma';
import { signToken, setAuthCookie, readUserFromReq, requireAuth, clearAuthCookie } from './auth';

const prisma = new PrismaClient();
const app = express();

// --- config / middleware ---
app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
  })
);
app.use(cookieParser());              // <- you had the import; now it's enabled
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_KEY || '';
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = (req.header('x-admin-key') || req.query.key) as string | undefined;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}
function makeSlug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// --- products: list w/ search + filter + pagination ---
app.get('/api/v1/products', async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  const category = (req.query.category as string | undefined)?.trim(); // slug or name
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.min(24, Math.max(1, Number(req.query.limit ?? 9)));
  const skip = (page - 1) * limit;

  const where: any = {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (category) {
    where.AND = [
      ...(where.OR ? [{ OR: where.OR }] : []),
      {
        OR: [
          { category: { slug: { equals: category, mode: 'insensitive' } } },
          { category: { name: { equals: category, mode: 'insensitive' } } },
        ],
      },
    ];
    delete where.OR;
  }

  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { category: true },
    }),
  ]);

  res.json({
    items,
    page,
    limit,
    total,
    pageCount: Math.max(1, Math.ceil(total / limit)),
  });
});

// --- categories ---
app.get('/api/v1/categories', async (_req, res) => {
  const cats = await prisma.category.findMany({ orderBy: { name: 'asc' } });
  res.json({ items: cats });
});

// --- get one product by slug ---
app.get('/api/v1/products/:slug', async (req, res) => {
  const item = await prisma.product.findUnique({
    where: { slug: req.params.slug },
    include: { category: true },
  });
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

// --- checkout (guest) ---
app.post('/api/v1/checkout', async (req, res) => {
  const { items, email } = req.body as {
    email?: string;
    items: { productId: string; quantity: number }[];
  };
  if (!items?.length) return res.status(400).json({ error: 'No items' });

  try {
    const ids = items.map((i) => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: ids } } });
    const map = new Map(products.map((p) => [p.id, p]));

    // validate
    for (const i of items) {
      const p = map.get(i.productId);
      if (!p) return res.status(400).json({ error: `Product not found: ${i.productId}` });
      if (i.quantity < 1) return res.status(400).json({ error: 'Invalid quantity' });
      if (p.stock < i.quantity) return res.status(400).json({ error: `Not enough stock for ${p.name}` });
    }

    const totalCents = items.reduce(
      (sum, i) => sum + map.get(i.productId)!.priceCents * i.quantity,
      0
    );

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: { userEmail: email?.toLowerCase() || null, totalCents },
      });

      for (const i of items) {
        const p = map.get(i.productId)!;
        await tx.orderItem.create({
          data: {
            orderId: created.id,
            productId: p.id,
            quantity: i.quantity,
            priceCents: p.priceCents,
          },
        });
        await tx.product.update({
          where: { id: p.id },
          data: { stock: { decrement: i.quantity } },
        });
      }
      return created;
    });

    res.json({ ok: true, orderId: order.id, totalCents });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// --- simple purchase history by email (both styles) ---
app.get('/api/v1/orders/by-email/:email', async (req, res) => {
  const email = String(req.params.email || '').toLowerCase();
  const orders = await prisma.order.findMany({
    where: { userEmail: email },
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ orders });
});

app.get('/api/v1/orders/by-email', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });

    const orders = await prisma.order.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, slug: true, imageUrl: true } },
          },
        },
      },
    });

    res.json({ items: orders });
  } catch (e) {
    console.error('by-email error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

/* ---------- AUTH ---------- */

// register
app.post('/api/v1/auth/register', async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (exists) return res.status(400).json({ error: 'Email already in use' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email: email.toLowerCase(), passwordHash, role: 'USER' } });

  const token = signToken(user.id);
  setAuthCookie(res, token);
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

// login
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(400).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Invalid email or password' });

  const token = signToken(user.id);
  setAuthCookie(res, token);
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

// current user
app.get('/api/v1/auth/me', async (req, res) => {
  const u = await readUserFromReq(req);
  if (!u) return res.json({ user: null });
  res.json({ user: { id: u.id, email: u.email, role: u.role } });
});

// logout
app.post('/api/v1/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// my orders (requires auth)  <-- IMPORTANT: use requireAuth(handler) pattern
app.get(
  '/api/v1/orders/my',
  requireAuth(async (req: any, res) => {
    const me = req.user;
    const orders = await prisma.order.findMany({
      where: { userId: me.id },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, slug: true, imageUrl: true } },
          },
        },
      },
    });
    res.json({ items: orders });
  })
);

/* ---------- ADMIN (x-admin-key) ---------- */

// ping
app.get('/api/v1/admin/ping', requireAdmin, (_req, res) => res.json({ ok: true }));

// list products
app.get('/api/v1/admin/products', requireAdmin, async (_req, res) => {
  const items = await prisma.product.findMany({
    orderBy: { createdAt: 'desc' },
    include: { category: { select: { id: true, name: true, slug: true } } },
  });
  res.json({ items });
});

// create product
app.post('/api/v1/admin/products', requireAdmin, async (req, res) => {
  const { name, slug, description, priceCents, imageUrl, stock, categorySlug } = req.body || {};
  if (!name || priceCents == null || !categorySlug)
    return res.status(400).json({ error: 'name, priceCents, categorySlug required' });

  const cat = await prisma.category.findUnique({ where: { slug: String(categorySlug) } });
  if (!cat) return res.status(400).json({ error: 'category not found' });

  const item = await prisma.product.create({
    data: {
      name,
      slug: slug ? String(slug) : makeSlug(name),
      description: description ?? '',
      priceCents: Number(priceCents),
      imageUrl: imageUrl ?? null,
      stock: Number(stock ?? 0),
      categoryId: cat.id,
    },
  });
  res.json({ item });
});

// update product
app.put('/api/v1/admin/products/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { name, slug, description, priceCents, imageUrl, stock, categorySlug } = req.body || {};
  const data: any = {};
  if (name != null) data.name = name;
  if (slug != null) data.slug = slug || makeSlug(name || '');
  if (description != null) data.description = description;
  if (priceCents != null) data.priceCents = Number(priceCents);
  if (imageUrl !== undefined) data.imageUrl = imageUrl;
  if (stock != null) data.stock = Number(stock);
  if (categorySlug) {
    const cat = await prisma.category.findUnique({ where: { slug: String(categorySlug) } });
    if (!cat) return res.status(400).json({ error: 'category not found' });
    data.categoryId = cat.id;
  }
  const item = await prisma.product.update({ where: { id }, data });
  res.json({ item });
});

// delete product
app.delete('/api/v1/admin/products/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  await prisma.product.delete({ where: { id } });
  res.json({ ok: true });
});

// list orders
app.get('/api/v1/admin/orders', requireAdmin, async (_req, res) => {
  const items = await prisma.order.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      items: {
        include: { product: { select: { id: true, name: true, slug: true, imageUrl: true } } },
      },
    },
  });
  res.json({ items });
});

// update order status (if your schema has a `status` field)
app.put('/api/v1/admin/orders/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status required' });
  try {
    const item = await prisma.order.update({ where: { id }, data: { status } as any });
    res.json({ item });
  } catch (e) {
    res.status(400).json({ error: 'status update not supported or invalid status' });
  }
});

// --- health ---
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = 4000;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
