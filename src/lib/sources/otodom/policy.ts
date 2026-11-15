export type OtodomContentSignal = {
  search?: string;
  "ai-input"?: string;
  "ai-train"?: string;
};

export function parseOtodomContentSignal(line: string): OtodomContentSignal {
  const value = line.replace(/^\s*Content-Signal\s*:\s*/i, "");
  const entries = value.split(",").flatMap((directive) => {
    const [rawKey, rawValue] = directive.split("=", 2);
    const key = rawKey?.trim().toLowerCase();
    const setting = rawValue?.trim().toLowerCase();
    if (!key || !setting) return [];
    return [[key, setting] as const];
  });
  return Object.fromEntries(entries) as OtodomContentSignal;
}

export function allowsOtodomAiInput(signal: OtodomContentSignal): boolean {
  return signal["ai-input"] === "yes";
}
