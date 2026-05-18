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
  // Tier-Fit Audit (added 2026-05-17 for /api/leads/tier-fit endpoint)
  audit_industry:           "jiY0Yke2HVpOEZbNytbp",
  audit_transactions:       "59tBryNrq3TrgeucyPHm",
  audit_accounts:           "F3H8omBRJZvPigG2TwXk",
  audit_employees:          "ER6KqiFKH27VrqTkZHWb",
  audit_revenue:            "IxiOzeTwQszErRSBl9fH",
  audit_flags:              "VD2LJGyzxhQm345z66RQ",
  audit_recommended_tier:   "6vsiYPKHMvIh0ILxdboo",
  audit_loss_estimate:      "bBYq6ErNgluOwF0q8Uul",
  audit_diagnostic_json:    "u6PW3A0G9lPBEGShfMm1",
  audit_submitted_at:       "wmFoo5IXtEpzeRUQ9Eff",
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
