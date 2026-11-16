export type ProviderKind = "chatgpt" | "claude" | "gemini" | "codex" | "ssh" | "vnc" | "rdp";
export type ProviderLaunchMode = "api" | "browser" | "external" | "native";
export type ProviderCapability = "chat" | "terminal" | "desktop" | "remote";

/** Non-secret capability metadata; credentials and connection targets stay outside this registry. */
export interface ProviderDescriptor {
  providerId: string;
  kind: ProviderKind;
  displayName: string;
  launchMode: ProviderLaunchMode;
  capabilities: readonly ProviderCapability[];
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDescriptor>();

  public register(provider: ProviderDescriptor): void {
    if (!provider.providerId.trim() || !provider.displayName.trim()) throw new Error("provider identity is required");
    if (!isProviderKind(provider.kind) || !isLaunchMode(provider.launchMode) || !provider.capabilities.every(isCapability)) {
      throw new Error("provider descriptor is invalid");
    }
    if (provider.capabilities.length === 0) throw new Error("provider must declare a capability");
    if (this.providers.has(provider.providerId)) throw new Error(`provider already registered: ${provider.providerId}`);
    this.providers.set(provider.providerId, Object.freeze({ ...provider, capabilities: Object.freeze([...provider.capabilities]) }));
  }

  public get(providerId: string): ProviderDescriptor | undefined {
    return this.providers.get(providerId);
  }

  public list(): readonly ProviderDescriptor[] {
    return Object.freeze([...this.providers.values()].sort((left, right) => left.displayName.localeCompare(right.displayName) || left.providerId.localeCompare(right.providerId)));
  }
}

function isProviderKind(value: unknown): value is ProviderKind {
  return value === "chatgpt" || value === "claude" || value === "gemini" || value === "codex" || value === "ssh" || value === "vnc" || value === "rdp";
}

function isLaunchMode(value: unknown): value is ProviderLaunchMode {
  return value === "api" || value === "browser" || value === "external" || value === "native";
}

function isCapability(value: unknown): value is ProviderCapability {
  return value === "chat" || value === "terminal" || value === "desktop" || value === "remote";
}
