import { defineConfig, env } from 'prisma/config';

/**
 * Prisma exists in this repository for one test.
 *
 * `fromPrisma` is a four-line adapter the SDK publicly supports, so it is exercised against
 * the real client rather than a hand-made object with the same shape. Everything Prisma
 * touches here — this config, prisma/schema.prisma, the generated client — is test
 * scaffolding standing in for a customer's application. None of it reaches `src/`, and
 * Prisma is never a runtime dependency of the published package.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
