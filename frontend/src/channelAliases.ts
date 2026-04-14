export type ChannelAliasMap = {
  /**
   * Map from raw channel name (from $PnN) to a human-friendly label.
   * The backend continues to see the raw name; this is purely a UI alias.
   */
  [rawName: string]: string;
};

export type PanelAliasConfig = {
  /**
   * Optional glob-like pattern (case-insensitive) matched against the file's
   * basename (e.g. "WBC_CP8.fcs"). If omitted, the aliases apply to all files.
   */
  fileNamePattern?: string;
  aliases: ChannelAliasMap;
};

// Central place for UX-level channel aliases.
// Intentionally empty by default: we rely on FCS header parsing for names.
export const PANEL_ALIASES: PanelAliasConfig[] = [];

export function getUiChannelLabel(
  rawName: string,
  fcsDisplayName: string,
  filePathOrSample?: string | null,
): string {
  const base = filePathOrSample ?? "";
  const baseName = base.split(/[/\\]/).pop() ?? "";
  const upperBase = baseName.toUpperCase();

  for (const cfg of PANEL_ALIASES) {
    if (cfg.fileNamePattern) {
      const pat = cfg.fileNamePattern.toUpperCase();
      if (!upperBase.includes(pat)) continue;
    }
    const alias = cfg.aliases[rawName];
    if (alias) return alias;
  }

  return fcsDisplayName || rawName;
}

