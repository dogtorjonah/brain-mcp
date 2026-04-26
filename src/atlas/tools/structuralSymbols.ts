const STRUCTURAL_SYMBOL_REGEX = /^[A-Za-z_$][\w$]*$/;
const IMPORT_EXPORT_FILE_REGEX = /\.[cm]?[jt]sx?$/i;

export function supportsStructuralImportExportAnalysis(filePath: string): boolean {
  return IMPORT_EXPORT_FILE_REGEX.test(filePath.trim());
}

export function isStructuralSymbolName(symbol: string): boolean {
  return STRUCTURAL_SYMBOL_REGEX.test(symbol.trim());
}

export function getStructuralSymbolRegex(symbol: string): RegExp | null {
  const normalized = symbol.trim();
  if (!isStructuralSymbolName(normalized)) {
    return null;
  }
  return new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}

export function includesStructuralSymbolByContext(candidate: string, symbol: string): boolean {
  const pattern = getStructuralSymbolRegex(symbol);
  return pattern ? pattern.test(candidate) : false;
}
