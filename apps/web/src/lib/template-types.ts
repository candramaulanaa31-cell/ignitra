import { OFFICIAL_TEMPLATES, outlineDefinition, planFor, type FlowTemplate, type TemplatePlaceholder } from "@ignitra/core";

/** Template shapes from GET /v1/templates(/:slug), with an offline fallback built from the official catalog. */

export interface TemplateCard {
  slug: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  official: boolean;
  visibility: "official" | "public" | "unlisted";
  author: string | null;
  trigger_type: string;
  action_types: string[];
  min_plan: "free" | "builder" | "team";
  uses: number;
}

export interface TemplateDetail extends TemplateCard {
  description: string;
  placeholders: TemplatePlaceholder[];
  definition: unknown;
  outline: Array<{ kind: "WHEN" | "IF" | "AND" | "OR" | "THEN"; text: string }>;
  share_text: string;
  url: string;
}

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  trading: "Trading",
  community: "Community",
  treasury: "Treasury",
  security: "Security",
  reporting: "Reporting",
  developers: "Developers",
};

const RANK = { free: 0, builder: 1, team: 2 } as const;

function officialCard(t: FlowTemplate): TemplateCard {
  const d = t.definition as { trigger: { type: string }; actions: Array<{ type: string }> };
  const types = [d.trigger.type, ...d.actions.map((a) => a.type)];
  const minPlan = types.map((x) => planFor(x as never)).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "free" as "free" | "builder" | "team");
  return { slug: t.slug, name: t.name, summary: t.summary, category: t.category, tags: [...t.tags], official: true, visibility: "official", author: null, trigger_type: d.trigger.type, action_types: d.actions.map((a) => a.type), min_plan: minPlan, uses: 0 };
}

export const officialCards = (): TemplateCard[] => OFFICIAL_TEMPLATES.map(officialCard);

export function officialDetail(slug: string, webUrl: string): TemplateDetail | null {
  const t = OFFICIAL_TEMPLATES.find((x) => x.slug === slug);
  if (!t) return null;
  return {
    ...officialCard(t),
    description: t.description,
    placeholders: [...t.placeholders],
    definition: t.definition,
    outline: outlineDefinition(t.definition, t.placeholders),
    share_text: t.shareText ?? `${t.name} — ${t.summary}`,
    url: `${webUrl}/templates/${t.slug}`,
  };
}

export function shareOnX(text: string, url: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(`${text}\n\n${url}`)}`;
}
