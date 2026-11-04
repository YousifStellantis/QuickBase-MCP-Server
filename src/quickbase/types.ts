/** The subset of Quickbase JSON API shapes this server reads. Unknown properties are preserved. */

export interface QbApp {
  id: string;
  name: string;
  description?: string;
  created?: string;
  updated?: string;
  dateFormat?: string;
  timeZone?: string;
  variables?: Array<{ name: string; value: string }>;
  ancestorId?: string;
  dataClassification?: string;
  [key: string]: unknown;
}

export interface QbTable {
  id: string;
  name: string;
  alias?: string;
  description?: string;
  keyFieldId?: number;
  singleRecordName?: string;
  pluralRecordName?: string;
  nextRecordId?: number;
  nextFieldId?: number;
  defaultSortFieldId?: number;
  defaultSortOrder?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface QbField {
  id: number;
  label: string;
  fieldType: string;
  mode?: string;
  required?: boolean;
  unique?: boolean;
  fieldHelp?: string;
  appearsByDefault?: boolean;
  audited?: boolean;
  properties?: {
    primaryKey?: boolean;
    foreignKey?: boolean;
    formula?: string;
    choices?: string[];
    lookupReferenceFieldId?: number;
    lookupTargetFieldId?: number;
    summaryFunction?: string;
    summaryReferenceFieldId?: number;
    summaryTargetFieldId?: number;
    defaultValue?: string;
    [key: string]: unknown;
  };
  permissions?: Array<{ role: string; roleId: number; permissionType: string }>;
  [key: string]: unknown;
}

export interface QbRelationship {
  id: number;
  parentTableId: string;
  childTableId: string;
  foreignKeyField?: { id: number; label: string; type: string };
  isCrossApp?: boolean;
  lookupFields?: Array<{ id: number; label: string; type: string }>;
  summaryFields?: Array<{ id: number; label: string; type: string }>;
}

export interface QbQueryResponse {
  data: Array<Record<string, { value: unknown }>>;
  fields: Array<{ id: number; label: string; type: string }>;
  metadata?: { totalRecords: number; numRecords: number; numFields: number; skip: number };
}

/** Built-in fields every Quickbase table has. */
export const BUILT_IN_FIELDS: Record<number, string> = {
  1: 'Date Created',
  2: 'Date Modified',
  3: 'Record ID#',
  4: 'Record Owner',
  5: 'Last Modified By',
};
