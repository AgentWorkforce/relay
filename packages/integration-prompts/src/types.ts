export type MaybePromise<T> = T | Promise<T>;

export interface WritableResourceDescriptor {
  path: string;
  createExamplePath?: string;
  schemaPath?: string;
  description?: string;
  name?: string;
}

export interface IntegrationSubscriptionSummary {
  provider?: string;
  watches: string[];
  targets?: string[];
}

export interface IntegrationDescriptor {
  provider: string;
  mountRoot: string;
  writableResources: WritableResourceDescriptor[];
  discoveryRoot?: string;
  displayName?: string;
  description?: string;
  scopeLabels?: string[];
  eventScopePaths?: string[];
  writebackPaths?: string[];
  subscriptions?: IntegrationSubscriptionSummary[];
  downloadHistoricalData?: boolean;
  liveContextPaths?: string[];
  skippedLocalPaths?: string[];
}

export type MountReadFile = (path: string) => MaybePromise<string | null | undefined>;

export type MountListPaths = (path: string) => MaybePromise<string[] | null | undefined>;

export interface MountDiscoveryReader {
  readFile: MountReadFile;
  listPaths?: MountListPaths;
  listTree?: MountListPaths;
}

export interface DeriveDescriptorsOptions {
  discoveryRoot?: string;
  knownProviders?: string[];
  listPaths?: MountListPaths;
  listTree?: MountListPaths;
}
