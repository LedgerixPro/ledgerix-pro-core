import { logger } from "../../middleware/logger.js";
import { ghlRequest } from "./client.js";
import type { GHLOpportunity, GHLPipeline } from "./types.js";

export interface CreateOpportunityParams {
  contactId: string;
  name: string;
  pipelineId?: string;
  stageId?: string;
  assignedTo?: string;
}

interface GHLOpportunityResponse {
  opportunity: GHLOpportunity;
}

interface GHLPipelinesResponse {
  pipelines: GHLPipeline[];
}

export async function createOpportunity(
  locationId: string,
  params: CreateOpportunityParams,
): Promise<GHLOpportunity> {
  const res = await ghlRequest<GHLOpportunityResponse>("POST", "/opportunities", {
    locationId,
    contactId: params.contactId,
    name: params.name,
    status: "open",
    ...(params.pipelineId !== undefined ? { pipelineId: params.pipelineId } : {}),
    ...(params.stageId !== undefined ? { pipelineStageId: params.stageId } : {}),
    ...(params.assignedTo !== undefined ? { assignedTo: params.assignedTo } : {}),
  });
  logger.info(
    { contactId: params.contactId, opportunityId: res.opportunity.id },
    "GHL opportunity created",
  );
  return res.opportunity;
}

export async function getPipelines(locationId: string): Promise<GHLPipeline[]> {
  const params = new URLSearchParams({ locationId });
  const res = await ghlRequest<GHLPipelinesResponse>("GET", `/opportunities/pipelines?${params}`);
  return res.pipelines;
}
