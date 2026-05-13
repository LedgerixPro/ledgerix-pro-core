export const FIELD_IDS = {
  client_type:              "Cf539co3LHJrm6wLAJQJ",
  service_tier:             "Dh5rwdlahz6a37BAQDIs",
  icp_status:               "r2elR53Q8VdI4MpAA0It",
  signal_confidence_score:  "gYdXRb56AUarXkgfz0jY",
  diagnostic_amount:        "kXo397ntvWymY6OP1ne4",
  nps_score:                "Dde0m2983zNBRgrCqjvU",
  ledgerix_workspace_id:    "vmAT4OjG10QboXA2Jqjs",
  nurture_month:            "sMQegZrU2giDsyaNKnjt",
  intake_lookback_days:     "hPSEYJlOUrhP31tgnMh5",
  intake_mode:              "zNjn0GEpygCcNB1j4h7v",
} as const;

export type FieldKey = keyof typeof FIELD_IDS;

// Shape used when writing to GHL (PUT /contacts/{id})
export interface GHLCustomFieldWrite {
  id: string;
  field_value: string | number;
}

// Shape returned by GHL when reading a contact (GET /contacts/{id})
export interface GHLCustomFieldRead {
  id: string;
  value: string | number;
}

export interface GHLContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  tags: string[];
  customFields: GHLCustomFieldRead[];
}

export interface GHLApiError {
  statusCode: number;
  message: string;
  error?: string;
}

export interface GHLContactSearchResult {
  contacts: GHLContact[];
  count: number;
  total: number;
}

// Conversations / Messages
export interface GHLMessage {
  id: string;
  conversationId: string;
  type: "SMS" | "Email";
  status: string;
}

export interface GHLSendMessageResult {
  conversationId: string;
  messageId: string;
  message?: GHLMessage;
}

// Opportunities / Pipelines
export interface GHLOpportunity {
  id: string;
  name: string;
  contactId: string;
  pipelineId: string;
  pipelineStageId: string;
  status: "open" | "won" | "lost" | "abandoned";
}

export interface GHLPipelineStage {
  id: string;
  name: string;
}

export interface GHLPipeline {
  id: string;
  name: string;
  stages: GHLPipelineStage[];
}
