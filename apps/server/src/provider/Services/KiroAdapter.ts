/**
 * KiroAdapter — shape type for the Kiro CLI provider adapter.
 *
 * The driver model bundles one adapter per configured instance, so this
 * module is a naming anchor for the per-instance Kiro adapter contract.
 *
 * @module KiroAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KiroAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
