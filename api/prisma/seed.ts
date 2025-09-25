import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const clothing = await prisma.category.upsert({
    where: { slug: 'clothing' },
    update: {},
    create: { name: 'Clothing', slug: 'clothing' },
  });

  await prisma.product.deleteMany();

  await prisma.product.createMany({
    data: [
      { name: 'Basic Tee', slug: 'basic-tee', description: 'Soft cotton tee', priceCents: 1999, imageUrl: 'https://picsum.photos/seed/tee/400/300', stock: 50, categoryId: clothing.id },
      { name: 'Hoodie', slug: 'hoodie', description: 'Comfy hoodie', priceCents: 4999, imageUrl: 'https://picsum.photos/seed/hoodie/400/300', stock: 30, categoryId: clothing.id },
      { name: 'Cap', slug: 'cap', description: 'Adjustable cap', priceCents: 1499, imageUrl: 'https://picsum.photos/seed/cap/400/300', stock: 80, categoryId: clothing.id },
      { name: 'Sneakers', slug: 'sneakers', description: 'Everyday sneakers', priceCents: 7999, imageUrl: 'https://picsum.photos/seed/sneakers/400/300', stock: 20, categoryId: clothing.id },
    ],
  });
}

main().finally(() => prisma.$disconnect());
