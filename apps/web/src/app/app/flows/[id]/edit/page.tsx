"use client";

import { use } from "react";
import { Builder } from "@/components/builder/builder";
import { Notice, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { FlowDetail } from "@/lib/types";

export default function EditFlowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const flow = useApi<{ data: FlowDetail }>(`/v1/flows/${id}`);
  if (flow.error) return <Notice kind="error">{flow.error.message}</Notice>;
  if (!flow.data) return <Spinner />;
  return (
    <main>
      <Builder initial={flow.data.data} />
    </main>
  );
}
