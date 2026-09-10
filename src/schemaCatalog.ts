import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ajv-formats ships a CJS `module.exports = formatsPlugin` with a mismatched
// ESM-style .d.ts (`export default`), which TypeScript under NodeNext resolves
// to a non-callable namespace type. Using createRequire + an explicit type
// import avoids `any` while getting the real callable export at runtime.
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

export const SCHEMA_BASE = "https://schemas.trust-layer.local/v0.3/";
const schemaNames = [
  "common-defs.json",
  "manifest-source-entry-v0.3.json",
  "report-domain-assessment.input.json",
  "report-domain-assessments-batch.input.json",
  "report-research-manifest.input.json",
  "submit-local-verification.input.json",
  "lookup-domain-signal.input.json",
  "report-domain-assessment.success.json",
  "report-domain-assessments-batch.success.json",
  "report-research-manifest.success.json",
  "submit-local-verification.success.json",
  "lookup-domain-signal.success.json",
  "public-domain-signal-v1.success.json",
  "common-error.json",
] as const;

export type SchemaName = (typeof schemaNames)[number];
export type ToolName = "report_domain_assessment" | "report_domain_assessments_batch" | "report_research_manifest" | "submit_local_verification" | "lookup_domain_signal";

const inputSchemaByTool: Record<ToolName, SchemaName> = {
  report_domain_assessment: "report-domain-assessment.input.json",
  report_domain_assessments_batch: "report-domain-assessments-batch.input.json",
  report_research_manifest: "report-research-manifest.input.json",
  submit_local_verification: "submit-local-verification.input.json",
  lookup_domain_signal: "lookup-domain-signal.input.json",
};
const successSchemaByTool: Record<Exclude<ToolName, "lookup_domain_signal"> | "lookup_domain_signal", SchemaName> = {
  report_domain_assessment: "report-domain-assessment.success.json",
  report_domain_assessments_batch: "report-domain-assessments-batch.success.json",
  report_research_manifest: "report-research-manifest.success.json",
  submit_local_verification: "submit-local-verification.success.json",
  lookup_domain_signal: "lookup-domain-signal.success.json",
};

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null | undefined;
}

export class SchemaCatalog {
  readonly ajv: Ajv2020;
  readonly schemas: Record<string, unknown>;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(schemaDir?: string) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const resolvedSchemaDir = schemaDir ?? (existsSync(join(moduleDir, "../schemas")) ? join(moduleDir, "../schemas") : join(moduleDir, "../../schemas"));
    this.ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats(this.ajv);
    this.schemas = {};
    // Add definitions/resources first, then the documents that reference them.
    for (const name of schemaNames) {
      const parsed = JSON.parse(readFileSync(join(resolvedSchemaDir, name), "utf8")) as { $id: string };
      this.schemas[name] = parsed;
      this.ajv.addSchema(parsed, parsed.$id);
    }
    for (const name of schemaNames) {
      const id = (this.schemas[name] as { $id: string }).$id;
      this.validators.set(name, this.ajv.getSchema(id) ?? this.ajv.compile(this.schemas[name] as never));
    }
  }

  validateSchema(name: SchemaName, value: unknown): ValidationResult {
    const validator = this.validators.get(name);
    if (!validator) throw new Error(`schema not loaded: ${name}`);
    const valid = validator(value);
    return { valid: Boolean(valid), errors: validator.errors };
  }

  validateInput(tool: ToolName, value: unknown): ValidationResult {
    return this.validateSchema(inputSchemaByTool[tool], value);
  }

  validateSuccess(tool: ToolName, value: unknown): ValidationResult {
    return this.validateSchema(successSchemaByTool[tool], value);
  }

  validateError(value: unknown): ValidationResult {
    return this.validateSchema("common-error.json", value);
  }

  validatePublicDomainSignal(value: unknown): ValidationResult {
    return this.validateSchema("public-domain-signal-v1.success.json", value);
  }

  schemaId(name: SchemaName): string {
    return (this.schemas[name] as { $id: string }).$id;
  }
}

export const schemaFileForTool = {
  input: inputSchemaByTool,
  success: successSchemaByTool,
};
