import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  OFFICIAL_TEMPLATES,
  checkTemplate,
  deriveTemplate,
  findOfficialTemplate,
  instantiateTemplate,
  newId,
  outlineDefinition,
  planFor,
  publishTemplateSchema,
  type FlowTemplate,
  type Plan,
} from "@ignitra/core";
import { templateStats, templates, users, type TemplateRow } from "@ignitra/db";
import { createFlow, getCurrentDefinition } from "@ignitra/engine";
import { audit } from "../audit";
import { caller } from "../auth";
import type { ApiContext } from "../context";
import { ApiError, RateLimiter, enforceRate, iso, notFound, parse } from "../http";

/**
 * Templates (spec Phase 7):
 *   GET    /v1/templates                      gallery: official + public community templates (public)
 *   GET    /v1/templates/:slug                one template, also unlisted ones (that is the share link) (public)
 *   POST   /v1/templates/:slug/instantiate    fill placeholders → a flow (signed in)
 *   POST   /v1/templates                      publish one of your flows as a template (signed in)
 *   GET    /v1/me/templates, DELETE /v1/templates/:slug
 */

interface Resolved {
  readonly template: FlowTemplate;
  readonly official: boolean;
  readonly author: string | null;
  readonly visibility: "official" | "public" | "unlisted";
  readonly createdAt: Date | null;
}

const PLAN_RANK: Record<Plan, number> = { free: 0, builder: 1, team: 2 };

function types(def: unknown): { trigger: string; actions: string[] } {
  const d = def as { trigger?: { type?: string }; actions?: Array<{ type?: string }> };
  return { trigger: d.trigger?.type ?? "", actions: (d.actions ?? []).map((a) => a.type ?? "") };
}

function minPlan(def: unknown): Plan {
  const t = types(def);
  return [t.trigger, ...t.actions].reduce<Plan>((acc, type) => {
    const p = planFor(type as never);
    return PLAN_RANK[p] > PLAN_RANK[acc] ? p : acc;
  }, "free");
}

const fromRow = (r: TemplateRow, author: string): Resolved => ({
  template: { slug: r.slug, name: r.name, summary: r.summary, description: r.description, category: r.category, tags: r.tags, placeholders: r.placeholders, definition: r.definition },
  official: false,
  author,
  visibility: r.visibility,
  createdAt: r.createdAt,
});

function card(r: Resolved, uses: number) {
  const t = types(r.template.definition);
  return {
    slug: r.template.slug,
    name: r.template.name,
    summary: r.template.summary,
    category: r.template.category,
    tags: r.template.tags,
    official: r.official,
    visibility: r.visibility,
    author: r.author,
    trigger_type: t.trigger,
    action_types: t.actions,
    min_plan: minPlan(r.template.definition),
    uses,
    created_at: iso(r.createdAt),
  };
}

export function registerPublicTemplateRoutes(app: FastifyInstance, ctx: ApiContext): void {
  async function resolve(slug: string): Promise<Resolved | null> {
    const official = findOfficialTemplate(slug);
    if (official) return { template: official, official: true, author: null, visibility: "official", createdAt: null };
    const [row] = await ctx.db
      .select({ t: templates, author: users.address })
      .from(templates)
      .innerJoin(users, eq(users.id, templates.ownerId))
      .where(and(eq(templates.slug, slug), isNull(templates.hiddenAt)));
    return row ? fromRow(row.t, row.author) : null;
  }

  async function uses(slugs: readonly string[]): Promise<Map<string, number>> {
    if (slugs.length === 0) return new Map();
    const rows = await ctx.db.select().from(templateStats).where(inArray(templateStats.slug, [...slugs]));
    return new Map(rows.map((r) => [r.slug, r.uses]));
  }

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/templates", async (req) => {
    const q = parse(z.object({ category: z.string().max(40).optional() }), req.query);
    const community = await ctx.db
      .select({ t: templates, author: users.address })
      .from(templates)
      .innerJoin(users, eq(users.id, templates.ownerId))
      .where(and(eq(templates.visibility, "public"), isNull(templates.hiddenAt)))
      .orderBy(desc(templates.createdAt))
      .limit(200);
    const all: Resolved[] = [
      ...OFFICIAL_TEMPLATES.map((t): Resolved => ({ template: t, official: true, author: null, visibility: "official", createdAt: null })),
      ...community.map((r) => fromRow(r.t, r.author)),
    ].filter((r) => !q.category || r.template.category === q.category);
    const counts = await uses(all.map((r) => r.template.slug));
    return { data: all.map((r) => card(r, counts.get(r.template.slug) ?? 0)) };
  });

  app.get<{ Params: { slug: string } }>("/v1/templates/:slug", async (req) => {
    const r = await resolve(req.params.slug);
    if (!r) throw notFound("template");
    const counts = await uses([r.template.slug]);
    return {
      data: {
        ...card(r, counts.get(r.template.slug) ?? 0),
        description: r.template.description,
        placeholders: r.template.placeholders,
        definition: r.template.definition,
        outline: outlineDefinition(r.template.definition, r.template.placeholders),
        share_text: r.template.shareText ?? `${r.template.name} — ${r.template.summary}`,
        url: `${ctx.webUrl}/templates/${r.template.slug}`,
      },
    };
  });

}

const instantiateBody = z
  .object({
    values: z.record(z.string(), z.unknown()).default({}),
    name: z.string().trim().min(1).max(120).optional(),
    activate: z.boolean().default(true),
  })
  .strict();

function slugFor(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "template";
  return `${base}-${randomBytes(4).toString("hex").slice(0, 6)}`;
}

export function registerTemplateRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const publishes = new RateLimiter(10, 3_600_000, ctx.now);

  async function resolveForUse(slug: string): Promise<FlowTemplate | null> {
    const official = findOfficialTemplate(slug);
    if (official) return official;
    const [row] = await ctx.db.select().from(templates).where(and(eq(templates.slug, slug), isNull(templates.hiddenAt)));
    return row ? { slug: row.slug, name: row.name, summary: row.summary, description: row.description, category: row.category, tags: row.tags, placeholders: row.placeholders, definition: row.definition } : null;
  }

  app.post<{ Params: { slug: string } }>("/v1/templates/:slug/instantiate", async (req, reply) => {
    const me = caller(req);
    const t = await resolveForUse(req.params.slug);
    if (!t) throw notFound("template");
    const body = parse(instantiateBody, req.body);
    // Checked again on use: rules added after a template was published apply to it too.
    const unusable = checkTemplate(t);
    if (unusable.length > 0) throw new ApiError(422, "invalid_template", `this template cannot be used: ${unusable.join("; ")}`);
    const built = instantiateTemplate(t, body.values);
    if ("issues" in built) throw new ApiError(422, "invalid_values", "some template values are missing or invalid", { issues: built.issues });
    const created = await createFlow(ctx.flowDeps, { ownerId: me.userId, name: body.name ?? t.name, definition: built.definition, activate: body.activate });
    await ctx.db
      .insert(templateStats)
      .values({ slug: t.slug, uses: 1, lastUsedAt: sql`now()` })
      .onConflictDoUpdate({ target: templateStats.slug, set: { uses: sql`${templateStats.uses} + 1`, lastUsedAt: sql`now()` } });
    ctx.logger.info({ userId: me.userId, template: t.slug, flowId: created.flowId, status: created.status }, "flow created from template");
    await audit(ctx, req, "flow.created", { type: "flow", id: created.flowId }, { name: body.name ?? t.name, from_template: t.slug, status: created.status });
    return reply.code(201).send({ data: { flow_id: created.flowId, status: created.status, version: created.version } });
  });

  app.post("/v1/templates", async (req, reply) => {
    const me = caller(req);
    const body = parse(publishTemplateSchema, req.body);
    enforceRate(publishes, me.userId, reply, "templates published this hour");
    const flow = await getCurrentDefinition(ctx.db, body.flow_id).catch(() => null);
    if (!flow || flow.ownerId !== me.userId) throw notFound("flow");
    const derived = deriveTemplate(flow.definition as never);
    const problems = checkTemplate(derived);
    if (problems.length > 0) throw new ApiError(422, "invalid_template", problems.join("; "));
    if (Buffer.byteLength(JSON.stringify(derived)) > 64 * 1024) throw new ApiError(413, "too_large", "the flow is too large to share");
    const slug = slugFor(body.name);
    const [row] = await ctx.db
      .insert(templates)
      .values({
        id: newId("template"),
        slug,
        ownerId: me.userId,
        name: body.name,
        summary: body.summary,
        description: body.description,
        category: body.category,
        tags: body.tags,
        placeholders: derived.placeholders,
        definition: derived.definition as unknown as Record<string, unknown>,
        visibility: body.visibility,
        sourceFlowId: body.flow_id,
      })
      .returning();
    if (!row) throw new Error("template insert failed");
    await audit(ctx, req, "template.published", { type: "template", id: row.id }, { slug, visibility: body.visibility });
    return reply.code(201).send({ data: { ...card(fromRow(row, me.address), 0), placeholders: derived.placeholders }, url: `${ctx.webUrl}/templates/${slug}` });
  });

  app.get("/v1/me/templates", async (req) => {
    const me = caller(req);
    const rows = await ctx.db.select().from(templates).where(eq(templates.ownerId, me.userId)).orderBy(desc(templates.createdAt));
    const stats = rows.length ? await ctx.db.select().from(templateStats).where(inArray(templateStats.slug, rows.map((r) => r.slug))) : [];
    const counts = new Map(stats.map((s) => [s.slug, s.uses]));
    return { data: rows.map((r) => ({ ...card(fromRow(r, me.address), counts.get(r.slug) ?? 0), hidden: r.hiddenAt !== null, url: `${ctx.webUrl}/templates/${r.slug}` })) };
  });

  app.delete<{ Params: { slug: string } }>("/v1/templates/:slug", async (req, reply) => {
    const me = caller(req);
    const rows = await ctx.db.delete(templates).where(and(eq(templates.slug, req.params.slug), eq(templates.ownerId, me.userId))).returning({ id: templates.id });
    if (rows.length === 0) throw notFound("template");
    await audit(ctx, req, "template.deleted", { type: "template", id: rows[0]?.id ?? null }, { slug: req.params.slug });
    return reply.code(204).send();
  });
}
