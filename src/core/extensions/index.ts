/**
 * Public surface of the extension system, also exported from the package root
 * as `cleanstack-generator/extensions`.
 */
export { ExtensionRegistryError, ExtensionRegistrySet } from './registry.js';
export { ExtensionError, loadExtensions } from './loader.js';
export {
  getActiveRegistry,
  setActiveRegistry,
  resetActiveRegistry,
  resolveActiveFieldType,
  activeFieldTypeNames,
  activeFrontendFrameworks,
  activeSchemaInput,
} from './registry.js';
export type {
  CleanStackExtension,
  ExtensionSpecifier,
  ExtensionRegistry,
  FieldKind,
  FieldSqlContext,
  FieldTypeDefinition,
  FrontendFrameworkDefinition,
  ResolvedFieldType,
} from './types.js';
export type { LoadExtensionsOptions, LoadExtensionsResult } from './loader.js';
