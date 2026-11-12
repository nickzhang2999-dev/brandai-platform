import { PrismaClient } from "@prisma/client";

// Older CDS fallback profiles can still invoke db:seed after migrations.
const deployed = Boolean(process.env.CDS_PROJECT_ID || process.env.CDS_COMMIT_SHA)
  || process.env.NODE_ENV === "production"
  || process.env.CI === "true";

if (deployed) {
  console.log("[db:seed] Deployment detected; skipped local demo data.");
  process.exit(0);
}

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "demo@brandai.dev" },
    update: {},
    create: { email: "demo@brandai.dev", name: "Demo User" },
  });

  // M-D — plans are seeded by the migration in prod; mirror them here so
  // `db push`-based local dev (which skips migration SQL) also has them.
  const PLANS = [
    { tier: "STARTER" as const, name: "Starter", priceCentsMonthly: 0, monthlyGenerationQuota: 600, dailyGenerationLimit: 30, maxWorkspaces: -1 },
    { tier: "PRO" as const, name: "Pro", priceCentsMonthly: 2900, monthlyGenerationQuota: 3000, dailyGenerationLimit: 100, maxWorkspaces: -1 },
    { tier: "TEAM" as const, name: "Team", priceCentsMonthly: 9900, monthlyGenerationQuota: 12000, dailyGenerationLimit: 400, maxWorkspaces: -1 },
    { tier: "ENTERPRISE" as const, name: "Enterprise", priceCentsMonthly: 0, monthlyGenerationQuota: -1, dailyGenerationLimit: -1, maxWorkspaces: -1 },
  ];
  // An explicit local seed also preserves any existing plan customization.
  for (const p of PLANS) {
    await prisma.plan.upsert({ where: { tier: p.tier }, update: {}, create: p });
  }

  const ws = await prisma.brandWorkspace.create({
    data: {
      ownerId: user.id,
      name: "Aroma Lab Coffee",
      industry: "F&B",
      websiteUrl: "https://example.com",
    },
  });

  await prisma.complianceTerm.createMany({
    data: [
      {
        workspaceId: ws.id,
        type: "FORBIDDEN",
        term: "第一",
        reason: "绝对化用语，广告法风险",
        replacement: "广受欢迎",
      },
      {
        workspaceId: ws.id,
        type: "FORBIDDEN",
        term: "100%",
        reason: "夸大收益/绝对化",
        replacement: "显著",
      },
      {
        workspaceId: ws.id,
        type: "CAUTION",
        term: "顶级",
        reason: "需人工确认是否有依据",
      },
    ],
  });

  console.log("Seeded workspace:", ws.id);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
