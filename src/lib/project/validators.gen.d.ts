// Hand-written typings for the GENERATED validators (validators.gen.js — Ajv
// standalone codegen; see scripts/gen-validators.mjs). The surface is stable:
// one boolean validator per schema, Ajv-shaped `errors` on the function.
export interface GenValidateError {
  instancePath?: string;
  message?: string;
  keyword?: string;
}
export type GenValidator = ((data: unknown) => boolean) & { errors?: GenValidateError[] | null };

export const validate_model: GenValidator;
export const validate_canvas: GenValidator;
export const validate_figIndex: GenValidator;
export const validate_deck: GenValidator;
export const validate_project: GenValidator;
